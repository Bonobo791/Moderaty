// Per-org credit ledger — the usage tab's source of truth and the billing
// gate for AI scoring. `organizations.credits_remaining` is authoritative;
// every mutation writes a credit_transactions row in the SAME transaction
// and the UNIQUE(org_id, ref_type, ref_id) anchor makes every operation
// idempotent (a comment is consumed once, a checkout session granted once —
// webhooks and retries can never double-apply).

import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { topupAttemptCorrelation, type TopupPayment } from './topupCorrelation';
import { creditTransactions, organizations, stripePendingReversals, stripeSubscriptionPeriods, stripeDisputeReversals, stripeAutoTopupRecoveries, stripeRefundObservations } from '$lib/server/db/schema';

export type CreditReason = 'consume' | 'purchase' | 'auto_topup' | 'refund' | 'dispute' | 'adjust';
// 'refund' and 'dispute' are reversal refTypes anchored on the charge id —
// DISTINCT anchors on purpose: a dispute reversal, a won-dispute restore, and
// a later full refund each apply exactly once without blocking one another.
// 'feedback' anchors digest classification on the comment id — distinct from
// the 'comment' moderation charge so a comment can carry one of each without
// colliding on the (org_id, ref_type, ref_id) unique anchor.
export type CreditRefType = 'comment' | 'feedback' | 'checkout_session' | 'payment_intent' | 'charge' | 'refund' | 'dispute' | 'admin';

/** The DB surface the ledger needs; both `db` and a transaction satisfy it. */
export type LedgerHandle = Pick<typeof db, 'insert' | 'update' | 'select' | 'delete' | 'run'>;

/**
 * Executes a ledger mutation within the available transaction context.
 *
 * @param handle - The database or transaction handle used for the mutation
 * @param run - The mutation callback to execute
 * @returns The value produced by the mutation callback
 */
const inLedgerTx = async <T>(handle: LedgerHandle, run: (tx: LedgerHandle) => Promise<T>): Promise<T> => {
	const withTx = (handle as { transaction?: (cb: (tx: LedgerHandle) => Promise<T>) => Promise<T> }).transaction;
	// .call(handle): drizzle's transaction() reads this.session — an unbound
	// method reference would crash on `this`.
	if (withTx) return withTx.call(handle, (tx) => run(tx as LedgerHandle));
	return run(handle);
};

export interface LedgerDelta {
	orgId: string;
	/** Positive = grant, negative = consume/reverse. */
	delta: number;
	reason: CreditReason;
	refType: CreditRefType;
	refId: string;
	/** Stripe reconciliation anchors (purchase/auto_topup rows). */
	paymentIntentId?: string;
	chargeId?: string;
	/** Original refund time, including when a reversal waits for its grant. */
	refundOccurredAt?: string;
	/** Recovery already carries the original refund intent; do not revoke later consent. */
	refundRecovery?: boolean;
	/** Terminal payment failures erase the grant without creating a credit debt. */
	floorAtZero?: boolean;
}

const UNIQUE_TARGET: [typeof creditTransactions.orgId, typeof creditTransactions.refType, typeof creditTransactions.refId] = [
	creditTransactions.orgId,
	creditTransactions.refType,
	creditTransactions.refId
];

export function hasHostedEntitlement(input: { plan: string; stripeSubscriptionId: string | null }): boolean {
	return input.plan === 'hosted' || (input.plan !== 'lifetime' && typeof input.stripeSubscriptionId === 'string');
}

// A paid, in-window subscription period always contributes its unconsumed
// included comments — the org paid for them and they were never refunded,
// whatever the current plan (a cancel→lifetime upgrade keeps the hosted
// period live until it ends). No plan gate here: the period row's status +
// window is the authority.
export function activeAllowanceSql(nowIso: string) {
	return sql<number>`COALESCE((
		SELECT SUM(p.included_credits - p.consumed_credits)
		FROM stripe_subscription_periods AS p
		WHERE p.org_id = organizations.id
			AND p.status = 'paid'
			AND p.period_start <= ${nowIso}
			AND p.period_end > ${nowIso}
	), 0)`;
}

export function effectiveBalanceSql(nowIso: string) {
	return sql<number>`COALESCE(${organizations.creditsRemaining}, 0) + ${activeAllowanceSql(nowIso)}`;
}

/**
 * True when the org ever received a paid subscription period — the durable
 * receipt of billing engagement. A bare `stripeSubscriptionId` is NOT:
 * `customer.subscription.created` stores it even for 'incomplete' subs whose
 * payment never ran, so the id alone must never mark an account as having
 * purchased (codex — the never-purchased retention exemption depends on it).
 * A 'void' period proves nothing; paid/disputed/refunded all mean money moved.
 */
export function paidSubscriptionPeriodExistsSql() {
	return sql<number>`EXISTS (
		SELECT 1 FROM stripe_subscription_periods AS p
		WHERE p.org_id = organizations.id AND p.status != 'void'
	)`;
}

/**
 * Retrieves an organization's current credit balance.
 *
 * @param orgId - The organization identifier
 * @returns The remaining credit balance, treating a missing balance as zero
 */
export async function getCredits(orgId: string): Promise<number> {
	const nowIso = new Date().toISOString();
	const row = await db
		.select({ remaining: effectiveBalanceSql(nowIso) })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.get();
	if (!row) throw new Error(`org not found: ${orgId}`);
	return row.remaining;
}

/**
 * True when the org has PURCHASED credits — a non-null balance. Metering
 * (the credit gate + per-comment consumption) applies only to metered orgs.
 * A non-null balance is the one reliable "billing engaged" signal: it is
 * written only by a successful credit grant (applyLedgerDelta COALESCEs
 * NULL → 0 on the FIRST purchase), survives spending down to 0, and is
 * never set by merely OPENING a Checkout. A Stripe customer alone is NOT
 * metering evidence — getOrCreateStripeCustomer provisions one at session
 * creation, so a cancelled/failed checkout would otherwise flip an
 * unlimited org (self-hosted, lifetime, fresh signup) into the credit gate
 * and defer every AI-scored comment for a purchase that never happened.
 */
/** Plans that promise UNLIMITED moderated comments — never metered, even
 * after a credit purchase (Terms §6.1(c): the lifetime hosted plan). A
 * lifetime org buying a bundle must not silently convert its unlimited
 * account into a finite balance that pauses AI scoring (codex review). */
const UNMETERED_PLANS = new Set(['lifetime']);

export function isUnmeteredPlan(plan: string | null | undefined): boolean {
	return UNMETERED_PLANS.has(plan ?? '');
}

/**
 * The metered predicate on an already-loaded org row — shared by
 * `orgIsMetered` and the zero-credit retention sweep so both classify the
 * same row identically (a metered org is billing-engaged: hosted plan,
 * subscription id, or a credit balance ever granted).
 */
export function orgRowIsMetered(row: {
	plan: string;
	stripeSubscriptionId: string | null;
	creditsRemaining: number | null;
}): boolean {
	if (isUnmeteredPlan(row.plan)) return false;
	return hasHostedEntitlement(row) || row.creditsRemaining !== null;
}

export async function orgIsMetered(orgId: string): Promise<boolean> {
	const row = await db
		.select({ creditsRemaining: organizations.creditsRemaining, plan: organizations.plan, stripeSubscriptionId: organizations.stripeSubscriptionId })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.get();
	if (!row) throw new Error(`org not found: ${orgId}`);
	return orgRowIsMetered(row);
}

export const UNMETERED_CREDIT_PURCHASE_ERROR = 'the lifetime plan includes unlimited moderated comments — credit purchases are not available';

/**
 * Rejects credit purchases for plans whose comments are already unlimited.
 * Called before a checkout attempt is planted for ANY credit bundle (Stripe
 * and Mercado Pago): a lifetime org buying credits pays real money for a
 * balance it can never need (MOD-35).
 */
export async function assertCreditsPurchasable(orgId: string): Promise<void> {
	const row = await db
		.select({ plan: organizations.plan })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.get();
	if (!row) throw new Error(`org not found: ${orgId}`);
	if (isUnmeteredPlan(row.plan)) {
		throw new Error(UNMETERED_CREDIT_PURCHASE_ERROR);
	}
}

export const UNMETERED_CREDIT_GRANT_ERROR = 'an unmetered plan cannot receive credit grants';

function refundPauseVersion(previous: string | null, advanceVersion?: boolean): string {
	if (advanceVersion === false && previous) return previous;
	return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
}

async function recordPausedAttempt(tx: LedgerHandle, orgId: string, org: { attemptAt: string | null; lastAttemptAt: string | null; submittedAt: string | null; customerId: string | null }, { payment, occurredAt }: { payment?: TopupPayment; occurredAt?: string }): Promise<void> {
	const attemptAt = org.attemptAt ?? org.lastAttemptAt;
	if (!attemptAt) throw new Error(`auto top-up claim for org ${orgId} has no attempt timestamp`);
	const correlation = payment ? topupAttemptCorrelation(payment, organizations.autoTopupLastAttemptAt) : undefined;
	const refundedAttempt = correlation ? await tx.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.id, orgId), correlation)).get() : undefined;
	if (!refundedAttempt) await tx.insert(stripeAutoTopupRecoveries).values({ orgId, attemptAt, customerId: org.customerId, refundOccurredAt: occurredAt,
		// Only a new logical attempt with no submission marker is provably unsent.
		resolvedAt: org.attemptAt && !org.submittedAt ? new Date().toISOString() : null }).onConflictDoNothing();
}

/** Caller supplies a transaction when the pause accompanies a credit reversal. */
export async function pauseAutoTopupForRefund(handle: LedgerHandle, orgId: string, occurredAt?: string, options: { chargeId?: string; payment?: TopupPayment; advanceVersion?: boolean } = {}): Promise<void> {
	return inLedgerTx(handle, async (tx) => {
		const org = await tx.select({ state: organizations.autoTopupState, lastAttemptAt: organizations.autoTopupLastAttemptAt, attemptAt: organizations.autoTopupAttemptAt, submittedAt: organizations.autoTopupSubmittedAt, customerId: organizations.stripeCustomerId, pauseReason: organizations.autoTopupPauseReason, pausedAt: organizations.autoTopupPausedAt }).from(organizations).where(eq(organizations.id, orgId)).get();
		if (!org) throw new Error(`org not found: ${orgId}`);
		const paused = await tx.update(organizations)
			.set({ autoTopupEnabled: 0, autoTopupState: 'disabled', autoTopupPauseReason: 'refund', autoTopupPausedAt: refundPauseVersion(org.pausedAt, options.advanceVersion), autoTopupAttemptAt: null, autoTopupSubmittedAt: null })
			.where(and(eq(organizations.id, orgId),
				// A delayed replay must respect consent explicitly given AFTER this refund.
				occurredAt ? or(isNull(organizations.autoTopupConsentedAt), sql`julianday(${organizations.autoTopupConsentedAt}) <= julianday(${occurredAt})`) : undefined))
			.returning({ id: organizations.id });
		if (paused.length && (org.state === 'in_flight' || org.attemptAt)) await recordPausedAttempt(tx, orgId, org, { payment: options.payment, occurredAt });
		if (occurredAt) {
			// Revisit history even if a later refund already paused this org.
			// Completed grants are already durable. Bound recoveries use their PI
			// as the key; only unbound attempts need a timestamp for Stripe lookup.
			await tx.run(sql`
				INSERT INTO ${stripeAutoTopupRecoveries} (org_id, customer_id, attempt_at, payment_intent_id, refund_occurred_at)
				SELECT ${creditTransactions.orgId}, ${org.customerId},
					'completed:' || ${creditTransactions.paymentIntentId}, ${creditTransactions.paymentIntentId}, ${occurredAt}
				FROM ${creditTransactions}
				WHERE ${creditTransactions.orgId} = ${orgId} AND ${creditTransactions.reason} = 'auto_topup'
					AND ${creditTransactions.delta} > 0 AND ${creditTransactions.createdAt} >= ${occurredAt}
					AND ${creditTransactions.paymentIntentId} IS NOT NULL
					AND (${options.payment?.id ?? null} IS NULL OR ${creditTransactions.paymentIntentId} != ${options.payment?.id ?? null})
					-- Consent cannot filter candidates: createdAt is grant-write
					-- (webhook) time, not charge time. Recovery arbitrates consent
					-- against the PaymentIntent's own provider-created timestamp.
					AND (${options.chargeId ?? null} IS NULL OR ${creditTransactions.chargeId} IS NULL
						OR ${creditTransactions.chargeId} != ${options.chargeId ?? null})
					AND NOT EXISTS (SELECT 1 FROM ${stripeAutoTopupRecoveries}
						WHERE ${stripeAutoTopupRecoveries.orgId} = ${orgId}
						AND ${stripeAutoTopupRecoveries.paymentIntentId} = ${creditTransactions.paymentIntentId})
				ON CONFLICT DO NOTHING
			`);
			// An earlier replay can prove a previously protected payment was a replacement.
			await tx.update(stripeAutoTopupRecoveries).set({ refundOccurredAt: occurredAt,
				resolvedAt: sql`CASE WHEN ${stripeAutoTopupRecoveries.lastError} = 'payment_precedes_refund' THEN NULL ELSE ${stripeAutoTopupRecoveries.resolvedAt} END`,
				lastError: sql`CASE WHEN ${stripeAutoTopupRecoveries.lastError} = 'payment_precedes_refund' THEN NULL ELSE ${stripeAutoTopupRecoveries.lastError} END`
			}).where(and(eq(stripeAutoTopupRecoveries.orgId, orgId), gt(stripeAutoTopupRecoveries.refundOccurredAt, occurredAt)));
		}
		if (paused.length) console.error(`auto top-up paused for org ${orgId}: automatic payments stopped — fresh owner consent required`);
	});
}

async function refundOwnerErased(tx: LedgerHandle, payment?: TopupPayment): Promise<boolean> {
	if (!payment) return false;
	const recovery = await tx.select({ orgId: stripeAutoTopupRecoveries.orgId }).from(stripeAutoTopupRecoveries).where(eq(stripeAutoTopupRecoveries.paymentIntentId, payment.id)).get();
	if (!recovery) return false;
	return !(await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, recovery.orgId)).get());
}

/** Each increase pauses once; unknown purchase links wait durably for the grant. */
export async function pauseForObservedStripeRefund(handle: LedgerHandle, orgId: string | undefined, chargeId: string, refundedAmountCents?: number, occurredAt?: string, payment?: TopupPayment): Promise<void> {
	return inLedgerTx(handle, async (tx) => {
		if (!orgId && await refundOwnerErased(tx, payment)) return;
		if (refundedAmountCents !== undefined) {
			const effectiveAt = occurredAt ?? new Date().toISOString();
			await tx.insert(stripeRefundObservations).values({ chargeId, refundedAmountCents, occurredAt: effectiveAt }).onConflictDoUpdate({
				target: stripeRefundObservations.chargeId,
				set: { refundedAmountCents, occurredAt: sql`MAX(${stripeRefundObservations.occurredAt}, ${effectiveAt})`, orgId: null },
				// The cumulative amount cannot distinguish a genuinely later
				// refund from a replay once Stripe reports the final total on an
				// earlier event; only a provider-supplied occurredAt can. And a
				// delayed earlier event may carry a larger cumulative amount with
				// an earlier time, so the boundary itself never regresses.
				setWhere: occurredAt === undefined
					? lt(stripeRefundObservations.refundedAmountCents, refundedAmountCents)
					: or(
						lt(stripeRefundObservations.refundedAmountCents, refundedAmountCents),
						and(eq(stripeRefundObservations.refundedAmountCents, refundedAmountCents), lt(stripeRefundObservations.occurredAt, occurredAt))
					)
			});
		}
		const observation = await tx.select().from(stripeRefundObservations).where(eq(stripeRefundObservations.chargeId, chargeId)).get();
		// An earlier event can reveal replacement charges before the latest refund.
		// Keep the cumulative amount's replay anchor and still honor later consent.
		if (observation && orgId && occurredAt && Date.parse(occurredAt) < Date.parse(observation.occurredAt)) {
			await pauseAutoTopupForRefund(tx, orgId, occurredAt, { chargeId, payment, advanceVersion: false });
		}
		if (!observation || observation.orgId || !orgId) return;
		await pauseAutoTopupForRefund(tx, orgId, observation.occurredAt, { chargeId, payment });
		await tx.update(stripeRefundObservations).set({ orgId }).where(eq(stripeRefundObservations.chargeId, chargeId));
	});
}

function adjustedCreditBalance(delta: number, reason: CreditReason, floorAtZero?: boolean) {
	// Keep the comparison reversed for Codacy's TypeScript parser.
	if (0 > delta && (reason === 'refund' || floorAtZero)) return sql`MAX(0, COALESCE(${organizations.creditsRemaining}, 0) + ${delta})`;
	return sql`COALESCE(${organizations.creditsRemaining}, 0) + ${delta}`;
}

/** Applies a credit adjustment exactly once; duplicate anchors return false. */
export async function applyLedgerDelta(
	handle: LedgerHandle,
	{ orgId, delta, reason, refType, refId, paymentIntentId, chargeId, refundOccurredAt, refundRecovery, floorAtZero }: LedgerDelta
): Promise<boolean> {
	return inLedgerTx(handle, async (tx) => {
		// Existence check first (mirrors consumeCredit): an unknown org is a
		// data bug and must fail loudly with the SAME message everywhere —
		// never surface the FK constraint error instead (the org FK is
		// defense-in-depth, not the primary guard).
		const org = await tx
			.select({ id: organizations.id, plan: organizations.plan })
			.from(organizations)
			.where(eq(organizations.id, orgId))
			.get();
		if (!org) throw new Error(`org not found: ${orgId}`);
		// Dedup BEFORE the plan guard: a redelivery of an already-applied delta
		// is an idempotent no-op regardless of the org's CURRENT plan — checking
		// the plan first would make callers refund a payment whose grant already
		// committed (a purchase granted while metered, replayed post-upgrade —
		// codex P1). The onConflictDoNothing below stays the atomic backstop
		// for two concurrent first-time grants racing past this read.
		const existing = await tx
			.select({ id: creditTransactions.id })
			.from(creditTransactions)
			.where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.refType, refType), eq(creditTransactions.refId, refId)))
			.get();
		if (existing) return false;
		// The atomic counterpart of assertCreditsPurchasable: checkout creation
		// is gated at the form, but a checkout in flight when the org went
		// lifetime must still not grant — paid-but-unusable credits get
		// refunded by the caller (review: TOCTOU). Only positive deltas are
		// blocked; reversals must always be able to claw a stranded balance back.
		if (delta > 0 && isUnmeteredPlan(org.plan)) throw new Error(UNMETERED_CREDIT_GRANT_ERROR);
		const inserted = await tx
			.insert(creditTransactions)
			.values({
				orgId,
				delta,
				reason,
				refType,
				refId,
				paymentIntentId,
				chargeId,
				balanceAfter: null
			})
			.onConflictDoNothing({ target: UNIQUE_TARGET })
			.returning({ id: creditTransactions.id });
		if (inserted.length === 0) return false; // already applied — idempotent no-op
		if (reason === 'refund' && 0 > delta && !refundRecovery) await pauseAutoTopupForRefund(tx, orgId, refundOccurredAt, { chargeId, payment: paymentIntentId ? { id: paymentIntentId, metadata: null } : undefined });
		if (delta > 0 && reason !== 'auto_topup' && chargeId) await pauseForObservedStripeRefund(tx, orgId, chargeId, undefined, undefined, paymentIntentId ? { id: paymentIntentId, metadata: null } : undefined);
		const updated = await tx
			.update(organizations)
			// COALESCE: pre-billing orgs carry NULL credits (I7 nullable-first);
			// NULL + delta would stay NULL forever, silently eating every grant.
			// REFUND reversals floor at zero: a refunded grant's credits are
			// GONE, not a negative debt carried against the next purchase —
			// "refunded" means the org owes nothing and holds nothing.
			// Dispute reversals stay unbounded on purpose: a won dispute
			// restores the FULL grant, so keeping the true negative is the
			// only math that restores correctly.
			.set({
				creditsRemaining:
					adjustedCreditBalance(delta, reason, floorAtZero)
			})
			.where(eq(organizations.id, orgId))
			.returning({ balance: organizations.creditsRemaining });
		if (updated.length === 0) throw new Error(`org not found: ${orgId}`);
		await tx
			.update(creditTransactions)
			.set({ balanceAfter: updated[0].balance })
			.where(eq(creditTransactions.id, inserted[0].id));
		return true;
	});
}

/**
 * The charge anchor for one moderated comment under a history rescan:
 * `${commentId}#${scanScope}` when the scan carries its per-request nonce, so
 * each requested scan debits once while retries of that same scan hit the
 * anchor and stage covered. A null scope is a drain planted before the nonce
 * column existed — it already charged the PLAIN comment id, so the anchor
 * must stay plain or the retry double-charges it (codex).
 */
export function commentChargeRef(commentId: string, scanScope?: string | null): string {
	return scanScope ? `${commentId}#${scanScope}` : commentId;
}

/**
 * True when a transaction row already anchors (orgId, refType, refId). After a
 * consume*Credit call returns false, this distinguishes "the charge already
 * exists" (a covered retry — stage without a new debit) from a real balance
 * shortfall.
 */
export async function hasChargeAnchor(
	handle: LedgerHandle,
	orgId: string,
	refType: 'comment' | 'feedback',
	refId: string
): Promise<boolean> {
	const prior = await handle
		.select({ id: creditTransactions.id })
		.from(creditTransactions)
		.where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.refType, refType), eq(creditTransactions.refId, refId)))
		.get();
	return Boolean(prior);
}

/** RefIds already anchored in the ledger — retries of an earlier charge. */
async function listAnchoredRefIds(
	tx: LedgerHandle,
	orgId: string,
	refType: 'comment' | 'feedback',
	refIds: string[]
): Promise<Set<string>> {
	const existing = await tx
		.select({ refId: creditTransactions.refId })
		.from(creditTransactions)
		.where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.refType, refType), inArray(creditTransactions.refId, refIds)))
		.all();
	return new Set(existing.map((row) => row.refId));
}

/**
 * Funds up to `needed` charges from paid, in-window subscription periods —
 * the period whose allowance expires FIRST is consumed first: spending the
 * newest period's included credits first would let the older period's
 * allowance lapse unused while fresh runway is burned (codex). Each
 * period's conditional UPDATE claims the credits atomically; a concurrent
 * change aborts the charge loudly instead of overdrawing the allowance.
 *
 * @returns The number of charges covered by subscription allowance
 */
async function consumeSubscriptionAllowance(tx: LedgerHandle, orgId: string, needed: number): Promise<number> {
	const now = new Date().toISOString();
	const periods = await tx
		.select({ id: stripeSubscriptionPeriods.id, includedCredits: stripeSubscriptionPeriods.includedCredits, consumedCredits: stripeSubscriptionPeriods.consumedCredits })
		.from(stripeSubscriptionPeriods)
		.where(and(
			eq(stripeSubscriptionPeriods.orgId, orgId),
			eq(stripeSubscriptionPeriods.status, 'paid'),
			sql`${stripeSubscriptionPeriods.periodStart} <= ${now}`,
			gt(stripeSubscriptionPeriods.periodEnd, now),
			sql`${stripeSubscriptionPeriods.consumedCredits} < ${stripeSubscriptionPeriods.includedCredits}`
		))
		.orderBy(asc(stripeSubscriptionPeriods.periodEnd), asc(stripeSubscriptionPeriods.id))
		.all();
	let funded = 0;
	for (const period of periods) {
		const available = Math.max(0, period.includedCredits - period.consumedCredits);
		const count = Math.min(needed - funded, available);
		if (count === 0) continue;
		const consumed = await tx
			.update(stripeSubscriptionPeriods)
			.set({ consumedCredits: sql`${stripeSubscriptionPeriods.consumedCredits} + ${count}` })
			.where(and(
				eq(stripeSubscriptionPeriods.id, period.id),
				sql`${stripeSubscriptionPeriods.consumedCredits} + ${count} <= ${stripeSubscriptionPeriods.includedCredits}`
			))
			.returning({ id: stripeSubscriptionPeriods.id });
		if (!consumed.length) throw new Error('subscription allowance changed concurrently — charge aborted');
		funded += count;
		if (funded === needed) break;
	}
	return funded;
}

/**
 * Funds up to `needed` charges from the org's purchased balance. The
 * conditional UPDATE claims the credits atomically — a concurrent debit
 * aborts loudly instead of double-spending.
 *
 * @returns The number of charges covered by the purchased balance
 */
async function consumePurchasedBalance(tx: LedgerHandle, orgId: string, creditsRemaining: number | null, needed: number): Promise<number> {
	const funded = Math.min(needed, Math.max(0, creditsRemaining ?? 0));
	if (funded === 0) return 0;
	const updated = await tx
		.update(organizations)
		.set({ creditsRemaining: sql`${organizations.creditsRemaining} - ${funded}` })
		.where(and(eq(organizations.id, orgId), sql`${organizations.creditsRemaining} >= ${funded}`))
		.returning({ creditsRemaining: organizations.creditsRemaining });
	if (!updated.length) throw new Error('credit balance changed concurrently — charge aborted');
	return funded;
}

/**
 * Writes one `consume` ledger row per charged ref. Period-funded rows record
 * the balance BEFORE this batch's purchased debit (allowance spend never
 * touched it); purchased-funded rows record the running balance after each
 * decrement. onConflictDoNothing + the row-count check catch a concurrent
 * charge that raced past the anchor read.
 */
async function insertConsumeRows(
	tx: LedgerHandle,
	orgId: string,
	refType: 'comment' | 'feedback',
	charged: string[],
	periodFunded: number,
	startingBalance: number | null
): Promise<void> {
	if (!charged.length) return;
	const rows = charged.map((refId, index) => ({
		orgId,
		delta: -1,
		reason: 'consume' as const,
		refType,
		refId,
		balanceAfter:
			// `periodFunded > index`, not `index < periodFunded`: lizard (Codacy)
			// misparses `identifier <` as a generic-arguments open.
			periodFunded > index
				? startingBalance
				: (startingBalance ?? 0) - (index - periodFunded + 1)
	}));
	const inserted = await tx
		.insert(creditTransactions)
		.values(rows)
		.onConflictDoNothing({ target: UNIQUE_TARGET })
		.returning({ refId: creditTransactions.refId });
	if (inserted.length !== rows.length) throw new Error('charge anchor inserted concurrently — charge aborted');
}

export async function consumeCreditsBulk(
	handle: LedgerHandle,
	orgId: string,
	refType: 'comment' | 'feedback',
	refIds: string[]
	// `metered` reports the org's plan state read in THIS transaction — callers
	// deciding whether an `uncharged` shortfall aborts must use it, not a
	// second out-of-tx read that can disagree under a concurrent billing
	// change (codeant). Absent when no charge was attempted (empty refIds).
): Promise<{ charged: string[]; covered: string[]; uncharged: string[]; metered?: boolean }> {
	const uniqueRefIds = [...new Set(refIds)];
	if (!uniqueRefIds.length) return { charged: [], covered: [], uncharged: [] };

	return inLedgerTx(handle, async (tx) => {
		// Existence check first: an unknown org is a data bug and must fail loudly,
		// not silently stage comments free.
		const org = await tx
			.select({ creditsRemaining: organizations.creditsRemaining, plan: organizations.plan, stripeSubscriptionId: organizations.stripeSubscriptionId })
			.from(organizations)
			.where(eq(organizations.id, orgId))
			.get();
		if (!org) throw new Error(`org not found: ${orgId}`);
		// Unmetered orgs (lifetime plans, and pre-billing orgs with no hosted
		// entitlement or granted balance) never consume: their scoring is
		// already unlimited, so a stranded balance must not burn 1-per-comment
		// for nothing — it freezes until the org is metered again (MOD-36).
		// Reported as uncharged like an exhausted balance; staging only
		// treats that as fatal for METERED orgs. The predicate is the shared
		// orgRowIsMetered so this classification matches orgIsMetered exactly.
		if (!orgRowIsMetered(org)) return { charged: [], covered: [], uncharged: uniqueRefIds, metered: false };

		const anchoredRefIds = await listAnchoredRefIds(tx, orgId, refType, uniqueRefIds);
		const covered = uniqueRefIds.filter((refId) => anchoredRefIds.has(refId));
		const toCharge = uniqueRefIds.filter((refId) => !anchoredRefIds.has(refId));
		if (!toCharge.length) return { charged: [], covered, uncharged: [], metered: true };

		// Subscription allowance funds first — the org already paid for those
		// included comments; the purchased balance covers the remainder.
		const periodFunded = hasHostedEntitlement(org)
			? await consumeSubscriptionAllowance(tx, orgId, toCharge.length)
			: 0;
		const purchasedFunded = await consumePurchasedBalance(tx, orgId, org.creditsRemaining, toCharge.length - periodFunded);
		const charged = toCharge.slice(0, periodFunded + purchasedFunded);
		await insertConsumeRows(tx, orgId, refType, charged, periodFunded, org.creditsRemaining);
		return { charged, covered, uncharged: toCharge.slice(charged.length), metered: true };
	});
}

/**
 * Charges one available credit anchored on (refType, refId).
 *
 * @returns `true` if this call charged, `false` if it was already charged or no credit was available
 * @throws Error if the organization does not exist
 */
async function consumeOneCredit(handle: LedgerHandle, orgId: string, refType: 'comment' | 'feedback', refId: string): Promise<boolean> {
	const result = await consumeCreditsBulk(handle, orgId, refType, [refId]);
	return result.charged.length === 1;
}

/**
 * Charges one available credit for a comment.
 *
 * @param orgId - The organization whose credits are charged
 * @param commentId - The comment associated with the charge
 * @returns `true` if this call charged the comment, `false` if it was already charged or no credit was available
 * @throws Error if the organization does not exist
 */
export async function consumeCredit(handle: LedgerHandle, orgId: string, commentId: string): Promise<boolean> {
	return consumeOneCredit(handle, orgId, 'comment', commentId);
}

export interface GrantMatch {
	orgId: string;
	credits: number;
}

/**
 * Locates credits granted for a Stripe payment intent or charge. Won-dispute
 * restores (reason 'adjust') are excluded: a refund reverses what the charge
 * ORIGINALLY granted, never money that came back via a dispute ruling.
 *
 * @param identifiers - Optional Stripe payment intent and charge identifiers used to match grant transactions.
 * @returns The organization ID and total granted credits, or `null` when no matching grant exists.
 */
export async function findGrantForStripe(
	handle: LedgerHandle,
	{ paymentIntentId, chargeId }: { paymentIntentId?: string; chargeId?: string }
): Promise<GrantMatch | null> {
	const byPi = paymentIntentId ? eq(creditTransactions.paymentIntentId, paymentIntentId) : undefined;
	const byCharge = chargeId ? eq(creditTransactions.chargeId, chargeId) : undefined;
	const match = byPi && byCharge ? or(byPi, byCharge) : (byPi ?? byCharge);
	if (!match) return null;
	const rows = await handle
		.select({ orgId: creditTransactions.orgId, delta: creditTransactions.delta })
		.from(creditTransactions)
		.where(and(match, sql`${creditTransactions.delta} > 0`, ne(creditTransactions.reason, 'adjust')))
		.all();
	if (rows.length === 0) return null;
	const orgId = rows[0].orgId;
	const credits = rows.reduce((sum, row) => sum + row.delta, 0);
	return { orgId, credits };
}

export interface UsageSummary {
	remaining: number;
	/** Lifetime credits consumed by moderation. */
	usedLifetime: number;
	/** Credits consumed since the first day of the current UTC month. */
	usedThisMonth: number;
}

/**
 * Summarizes remaining and consumed moderation credits for an organization.
 *
 * @param orgId - The organization whose credit usage is summarized
 * @returns The remaining credits, lifetime consumed credits, and credits consumed during the current UTC month
 */
export async function usageSummary(orgId: string): Promise<UsageSummary> {
	const remaining = await getCredits(orgId);
	const monthStart = monthStartIso();
	// "Used" means comment-processing consumption (moderation 'comment' and
	// digest 'feedback' charges alike — both are spent credits): refund and
	// dispute reversals are also negative-delta rows, but they are money
	// leaving the ledger, not work performed — summing every negative row
	// would inflate the stats.
	// Aggregated in SQL over the (org_id, created_at) index: the usage page
	// must stay bounded as the ledger grows, never fetch every consume row
	// into memory just to add it up in JS.
	const consume = and(
		eq(creditTransactions.orgId, orgId),
		eq(creditTransactions.reason, 'consume'),
		lt(creditTransactions.delta, 0)
	);
	const [lifetime, month] = await Promise.all([
		db
			.select({ used: sql<number>`COALESCE(SUM(ABS(${creditTransactions.delta})), 0)` })
			.from(creditTransactions)
			.where(consume)
			.get(),
		db
			.select({ used: sql<number>`COALESCE(SUM(ABS(${creditTransactions.delta})), 0)` })
			.from(creditTransactions)
			.where(and(consume, gte(creditTransactions.createdAt, monthStart)))
			.get()
	]);
	return { remaining, usedLifetime: lifetime?.used ?? 0, usedThisMonth: month?.used ?? 0 };
}

/**
 * Determines the start of the current UTC month.
 *
 * @returns An ISO timestamp for the first day of the current UTC month at midnight
 */
export function monthStartIso(): string {
	const now = new Date();
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00.000Z`;
}


/** Recent ledger rows for the usage page's history list. */
export async function listCreditTransactions(orgId: string, limit = 50) {
	return db
		.select()
		.from(creditTransactions)
		.where(eq(creditTransactions.orgId, orgId))
		.orderBy(sql`${creditTransactions.createdAt} desc, ${creditTransactions.id} desc`)
		.limit(limit)
		.all();
}

/**
 * Records that a refund/dispute reversal is owed for a charge whose credit
 * grant had not yet arrived (Stripe webhook delivery order is not
 * guaranteed). charge_id UNIQUE: one reversal per charge, first event wins.
 */
export async function queuePendingReversal(chargeId: string, reason: 'refund' | 'dispute', disputeId?: string, occurredAt?: string): Promise<void> {
	// UNIQUE(charge_id, reason) — NOT charge_id alone: a dispute AND a later
	// full refund can both arrive before the delayed grant, and each
	// obligation must survive to drain on its own ledger anchor (a won-dispute
	// restore must not leave credits in place for a charge that was also fully
	// refunded). The charge-only key silently dropped whichever reason arrived
	// second (codex review).
	await db
		.insert(stripePendingReversals)
		.values({ chargeId, reason, disputeId, occurredAt })
		.onConflictDoUpdate({
			target: [stripePendingReversals.chargeId, stripePendingReversals.reason],
			set: { disputeId: sql`COALESCE(${stripePendingReversals.disputeId}, excluded.dispute_id)`, occurredAt: sql`COALESCE(${stripePendingReversals.occurredAt}, excluded.occurred_at)` }
		});
}

/**
 * Applies every pending reversal whose grant has now landed. Called right
 * after a grant for the charge (checkout fulfillment and auto top-up), so a
 * reversal that beat its grant still takes the credits exactly once.
 *
 * @param chargeId - The charge whose pending reversals should be drained
 * @returns The number of reversals applied
 */
export async function drainPendingReversals(chargeId: string): Promise<number> {
	// Order matters when a charge carries both obligations: the dispute
	// reversal is unbounded (a later won-dispute restore re-adds the full
	// grant) while the refund reversal floors at zero, so the dispute must
	// apply FIRST and the refund LAST — draining the other way could leave a
	// negative balance the refund was supposed to prevent. 'dispute' sorts
	// before 'refund' alphabetically; ORDER BY makes the contract explicit
	// instead of trusting SQLite's index scan order (cubic review).
	const pending = await db
		.select()
		.from(stripePendingReversals)
		.where(eq(stripePendingReversals.chargeId, chargeId))
		.orderBy(asc(stripePendingReversals.reason))
		.all();
	let drained = 0;
	for (const row of pending) {
		const match = await findGrantForStripe(db, { chargeId });
		// The grant still has not landed — keep the obligation for the next
		// grant (the sweep drops rows whose grant never arrives).
		if (!match) continue;
		// Crash-consistency (human review): each row's ledger mutation and its
		// delete must be ONE transaction, and the delete must target the row's
		// own id. Deleting by chargeId after the first row would erase the
		// second (refund + dispute) obligation before its mutation runs — a
		// crash in between would make the retry unable to reconcile it.
		await db.transaction(async (tx) => {
			if (row.reason === 'dispute' && row.disputeId) {
				const dispute = await tx.select({ status: stripeDisputeReversals.status }).from(stripeDisputeReversals).where(eq(stripeDisputeReversals.disputeId, row.disputeId)).get();
				if (dispute?.status === 'won') {
					await tx.update(stripeDisputeReversals).set({ source: 'credits', status: 'restored' }).where(eq(stripeDisputeReversals.disputeId, row.disputeId));
					await tx.delete(stripePendingReversals).where(eq(stripePendingReversals.id, row.id));
					return;
				}
			}
			// A disputed customer must never be re-charged off-session — same
			// policy as reverseDispute, applied at drain time (the dispute event
			// found no org to disable when it arrived).
			if (row.reason === 'dispute') {
				await tx
					.update(organizations)
					.set({ autoTopupEnabled: 0, autoTopupState: 'disabled' })
					.where(eq(organizations.id, match.orgId));
			}
			// Same anchors as reverseCharge: refType 'refund'/'dispute', refId =
			// charge id — a later won-dispute restore still finds the 'dispute'
			// reversal, and a later full refund applies on its own anchor.
			await applyLedgerDelta(tx, {
				orgId: match.orgId,
				delta: -match.credits,
				// The table only ever holds 'refund' | 'dispute' (queuePendingReversal
				// types it), but the DB column reads back as string — narrow it.
				reason: row.reason === 'dispute' ? 'dispute' : 'refund',
				refType: row.reason === 'refund' ? 'refund' : 'dispute',
				refId: chargeId,
				chargeId,
				refundOccurredAt: row.occurredAt ?? row.createdAt
			});
			if (row.reason === 'dispute' && row.disputeId) await tx.update(stripeDisputeReversals).set({ source: 'credits', status: 'reversed' }).where(eq(stripeDisputeReversals.disputeId, row.disputeId));
			// Satisfied (whether applied now or by a concurrent path): the anchor
			// makes double-application impossible, so the obligation is done.
			await tx.delete(stripePendingReversals).where(eq(stripePendingReversals.id, row.id));
		});
		drained += 1;
	}
	return drained;
}

/** Stale pending reversals are dropped after Stripe's webhook retry horizon
 * plus a margin: a grant that has not landed within 14 days never will (a
 * lost grant event is itself retried for only 3 days), so the row is dead
 * weight. Bounded per invocation (I10); loud when anything is dropped. */
export async function sweepStalePendingReversals(limit = 20): Promise<number> {
	const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
	const stale = await db
		.select({ id: stripePendingReversals.id, chargeId: stripePendingReversals.chargeId })
		.from(stripePendingReversals)
		.where(lt(stripePendingReversals.createdAt, cutoff))
		.limit(limit)
		.all();
	if (!stale.length) return 0;
	await db.delete(stripePendingReversals).where(inArray(stripePendingReversals.id, stale.map((row) => row.id)));
	console.error(
		`stripe: dropped ${stale.length} stale pending reversal(s) (grant never arrived within 14 days): ${stale.map((row) => row.chargeId).join(', ')}`
	);
	return stale.length;
}
