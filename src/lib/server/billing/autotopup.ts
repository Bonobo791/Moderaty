// Auto top-up: when an org's credit balance drops below its threshold, charge
// the saved card off-session for another bundle. Guard rails (all researched
// in docs/stripe-auto-topup.md):
//  - atomic in-flight claim (UPDATE ... WHERE auto_topup_state='idle') so two
//    concurrent triggers cannot both charge;
//  - idempotency key per customer per day (`autotopup:{cus}:{date}:{attempt}`)
//    so even a lost race collapses into one charge;
//  - cooldown ≥24h and caps of 1/day, 30/month;
//  - credits are granted ONLY by the payment_intent.succeeded webhook
//    (fulfillAutoTopup), never at charge-creation time;
//  - authentication_required (SCA) can never be retried off-session — the
//    state flips to 'disabled' and the customer must re-authenticate via a
//    fresh Checkout. Other declines disable after 2 consecutive failures.

import { and, asc, count, eq, gte, inArray, isNotNull, isNull, ne, not, or, sql } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { CronDiagnostics, describeCronFailure, formatCronFailure, withDiagnosticOperation } from '../../../../scripts/lib/cron-diagnostics.mjs';
import { activeAllowanceSql, applyLedgerDelta, pauseForObservedStripeRefund, drainPendingReversals, effectiveBalanceSql, isUnmeteredPlan, UNMETERED_CREDIT_GRANT_ERROR } from '$lib/server/billing/ledger';
import { creditTransactions, organizations } from '$lib/server/db/schema';
import { type CreditBundle, autoTopupBundle, bundleById, configuredAutoTopupBundles, priceIdFor } from '$lib/server/stripe/bundles';
import { getStripe } from '$lib/server/stripe/client';
import { refundUngrantablePayment } from '$lib/server/stripe/refunds';
import { findPausedTopup, recoverPausedTopup, sweepPausedTopups, topupAttemptCorrelation } from './autoTopupRecovery';

export const AUTO_TOPUP_DEFAULT_THRESHOLD = 100;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
// The ONLY nonterminal PI status that can never settle: Stripe leaves a
// declined off-session PI in requires_payment_method, and it cannot move
// without a re-confirmation this code never sends. Every other non-canceled
// status defers a new charge (a second PI could double-charge).
const DEAD_PI_STATUS = 'requires_payment_method';
// Every PaymentIntent status Stripe documents today (the SDK's
// PaymentIntent.Status union). An out-of-enum value — missing, renamed, or
// brand-new — means the response can no longer be trusted to mean what this
// code assumes about money movement, so the API call fails loudly (I2)
// rather than guessing: guessing "dead" risks a double charge; guessing
// "settling" starves the org silently for the whole reconcile window.
const KNOWN_PI_STATUSES = new Set([DEAD_PI_STATUS, 'requires_confirmation', 'requires_action', 'processing', 'requires_capture', 'canceled', 'succeeded']);
const MAX_PER_DAY = 1;
const MAX_PER_MONTH = 30;
const MAX_CONSECUTIVE_FAILURES = 2;
// Stripe retries webhook deliveries for up to 3 days; a claim left in_flight
// past that horizon means the webhook is definitively lost, so the sweep
// unsticks it (worst case: one duplicate charge, guarded by the daily cap
// and the idempotency key).
const STALE_CLAIM_MS = 3 * 24 * 60 * 60 * 1000;
// The reconciliation window must EXCEED the stale-claim horizon: a claim
// only becomes stale at 72h, so the very PI it exists to recover was created
// BEFORE the window. 7 days keeps the list tiny (30/month cap).
const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface AutoTopupState {
	enabled: number | null;
	threshold: number | null;
	bundle: string | null;
	state: string | null;
	lastAttemptAt: string | null;
	attemptAt: string | null;
	failures: number | null;
	customerId: string | null;
	defaultPmId: string | null;
	creditsRemaining: number | null;
	allowanceRemaining: number;
	plan: string | null;
}

/**
 * Retrieves an organization's auto-top-up configuration and billing state.
 *
 * @param orgId - The organization's identifier
 * @returns The organization's auto-top-up settings, Stripe payment details, and remaining credits
 * @throws Error if the organization does not exist
 */
export async function readAutoTopupState(orgId: string): Promise<AutoTopupState> {
	const nowIso = new Date().toISOString();
	const org = await db
		.select({
			enabled: organizations.autoTopupEnabled,
			threshold: organizations.autoTopupThreshold,
			bundle: organizations.autoTopupBundle,
			state: organizations.autoTopupState,
			lastAttemptAt: organizations.autoTopupLastAttemptAt,
			attemptAt: organizations.autoTopupAttemptAt,
			failures: organizations.autoTopupFailures,
			customerId: organizations.stripeCustomerId,
			defaultPmId: organizations.stripeDefaultPmId,
			creditsRemaining: organizations.creditsRemaining,
			allowanceRemaining: activeAllowanceSql(nowIso),
			plan: organizations.plan
		})
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.get();
	if (!org) throw new Error(`org not found: ${orgId}`);
	return org;
}

/**
 * Computes the UTC calendar date after applying a time offset.
 *
 * @param offsetMs - The offset from the current time, in milliseconds
 * @returns The resulting date in `YYYY-MM-DD` format
 */
function startOfUtcDayIso(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString().slice(0, 10);
}

/**
 * Counts automatic top-up credit transactions recorded since a timestamp.
 *
 * @param orgId - The organization whose transactions are counted
 * @param sinceIso - The ISO timestamp from which transactions are included
 * @returns The number of matching automatic top-up transactions
 */
async function topupCountsSince(orgId: string, sinceIso: string): Promise<number> {
	// COUNT in SQL with the createdAt predicate pushed down: the cap check runs
	// twice per trigger and the ledger grows without bound, so loading every
	// auto_topup row into memory to filter in JS would be unbounded work.
	const row = await db
		.select({ n: count() })
		.from(creditTransactions)
		.where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.reason, 'auto_topup'), gte(creditTransactions.createdAt, sinceIso)))
		.get();
	return row?.n ?? 0;
}

/**
 * Extracts a Stripe error code or a fallback representation of the error.
 *
 * @param error - The error from which to extract a code.
 * @returns The `code`, `decline_code`, error message, or string representation, in that order of precedence.
 */
export function stripeErrorCode(error: unknown): string {
	if (error && typeof error === 'object') {
		// Prefer decline_code: a card decline's generic `code` is
		// 'card_declined', while decline_code carries the SPECIFIC reason
		// (e.g. 'authentication_required') that decides the failure path.
		const declineCode = (error as { decline_code?: unknown }).decline_code;
		if (typeof declineCode === 'string') return declineCode;
		const code = (error as { code?: unknown }).code;
		if (typeof code === 'string') return code;
	}
	if (error instanceof Error) return error.message;
	// Never throw on serialization (circular / BigInt values): a card-decline
	// failure must still record and release the claim. 'unknown_error' is a
	// stable, non-throwing fallback.
	try {
		return JSON.stringify(error) ?? 'unknown_error';
	} catch {
		return 'unknown_error';
	}
}

/**
 * True when a paymentIntents.create failure is a CARD failure (decline,
 * expired card, SCA-required) rather than an infrastructure failure (network
 * outage, timeout, rate limit, invalid request, Stripe API error). Only card
 * failures count against the org's consecutive-failure counter — two
 * unrelated API outages must never disable auto top-up.
 */
function isCardFailure(error: unknown): boolean {
	if (error && typeof error === 'object') {
		const type = (error as { type?: unknown }).type;
		// stripe-node surfaces ordinary declines as type 'StripeCardError'
		// (the API's raw error carries type 'card_error' on error.raw); the
		// SDK's own type field never equals the raw API type. Accept both so
		// a plain card_declined is counted as a card failure, not an
		// infrastructure blip (codex 6156).
		if (type === 'card_error' || type === 'StripeCardError') return true;
		const rawType = (error as { raw?: { type?: unknown } }).raw?.type;
		if (rawType === 'card_error') return true;
		// Auth codes are card failures even when the type field is absent.
		const code = stripeErrorCode(error);
		return (
			code === 'authentication_required' ||
			code === 'authentication_not_handled' ||
			code === 'requires_action' ||
			code.includes('authentication_required') // legacy message-shaped callers
		);
	}
	return false;
}

/**
 * Attempts to initiate an off-session Stripe auto-top-up when the organization is eligible.
 *
 * Payment failures are recorded and result in `false`; setup and configuration errors may
 * propagate before a top-up is claimed.
 *
 * @param orgId - The organization to charge
 * @returns `true` if a payment was initiated, `false` if the organization was ineligible or payment initiation failed
 */
/** True when the org passes the cheap eligibility checks (no DB counts yet). */
function basicEligibility(org: AutoTopupState): boolean {
	// An unmetered plan (lifetime) never needs a top-up — unlimited scoring
	// makes the charge pure waste. An enabled flag on one is a data anomaly
	// (the org upgraded while enabled): loud, then skip (MOD-35).
	if (isUnmeteredPlan(org.plan)) {
		if (org.enabled === 1) console.error(`auto top-up skipped for unmetered org (plan ${org.plan}) despite an enabled flag — data anomaly`);
		return false;
	}
	if (org.enabled !== 1) return false;
	if ((org.creditsRemaining ?? 0) + org.allowanceRemaining >= (org.threshold ?? AUTO_TOPUP_DEFAULT_THRESHOLD)) return false;
	if (org.state === 'disabled') {
		console.error(`auto top-up skipped for org ${org.customerId ?? org.defaultPmId ?? 'unknown'}: disabled (re-authentication or repeated failures)`);
		return false;
	}
	if (org.state === 'in_flight') return false; // a charge is already pending
	if (!org.customerId || !org.defaultPmId) return false; // no saved card
	const lastAttempt = org.lastAttemptAt ? Date.parse(org.lastAttemptAt) : 0;
	if (lastAttempt && Date.now() - lastAttempt < COOLDOWN_MS) return false;
	return true;
}

/** True when the daily/monthly top-up limits are exhausted. */
function rateLimited(dayCount: number, monthCount: number): boolean {
	return dayCount >= MAX_PER_DAY || monthCount >= MAX_PER_MONTH;
}

async function handleTopupFailure(orgId: string, attemptAt: string, error: unknown, paymentCreated: boolean): Promise<void> {
	// Classification matters: a CARD failure (decline/SCA) records against
	// the org — repeated failures disable auto top-up. An infrastructure
	// failure (timeout, outage, rate limit, invalid request) is not the
	// customer's card: release the claim back to idle WITHOUT counting it,
	// so the next sweep retries normally and auto top-up is never disabled
	// by two unrelated API outages. Either way the failure is loud.
	if (isCardFailure(error)) {
		// A create-time confirmation failure (decline, expired card...) never
		// fires payment_failed — record it here with the real Stripe error
		// CODE (never the message: SCA codes like authentication_required
		// must disable auto top-up, and messages are locale-dependent).
		await recordAutoTopupFailure(orgId, stripeErrorCode(error));
	} else {
		const rejected = error as { type?: unknown; statusCode?: unknown; code?: unknown; raw?: { payment_intent?: unknown } };
		const definitelyUncreated = !paymentCreated && rejected?.type === 'StripeInvalidRequestError' && rejected.statusCode === 400 && !rejected.raw?.payment_intent;
		// The attempt timestamp clears with the claim: the failure was not
		// the customer's card, so the 24h cooldown must not stall the next
		// sweep. A declined card keeps its timestamp (don't hammer a bad
		// card for a day); an outage must be retried as soon as it clears.
		await db
			.update(organizations)
			.set({ autoTopupState: 'idle', autoTopupLastAttemptAt: null, ...(definitelyUncreated ? { autoTopupAttemptAt: null, autoTopupSubmittedAt: null } : {}) })
			.where(and(eq(organizations.id, orgId), eq(organizations.autoTopupState, 'in_flight'), eq(organizations.autoTopupAttemptAt, attemptAt)));
		console.error('auto top-up infra failure — conditional claim release attempted without counting a decline');
	}
}

/** Preserve failure-state handling and report the original error even if that write fails. */
async function handleAndReportTopupFailure(orgId: string, attemptAt: string, error: unknown, paymentCreated: boolean, reporting: { diagnostics?: CronDiagnostics; label: string }): Promise<void> {
	try {
		await handleTopupFailure(orgId, attemptAt, error, paymentCreated);
	} finally {
		if (reporting.diagnostics) reporting.diagnostics.report(reporting.label, error);
		else console.error('auto top-up operation failed:', formatCronFailure(describeCronFailure(error, reporting.label)));
	}
}

/** The enabled in-flight claim must still belong to this attempt before submission. */
function hasCurrentTopupClaim(org: AutoTopupState, attemptAt: string): boolean {
	return org.enabled === 1 && org.state === 'in_flight' && org.lastAttemptAt === attemptAt;
}

/** Preserve thrown setup errors for callers outside a correlated cron sweep. */
function withTopupDiagnosticOperation<T>(diagnostics: CronDiagnostics | undefined, operation: string, run: () => Promise<T>): Promise<T> {
	return diagnostics ? withDiagnosticOperation(operation, run) : run();
}

/** Resolve and validate pricing before any claim can be taken. */
async function resolveTopupPricing(orgId: string, choice: string | null): Promise<{ bundle: CreditBundle; amount: number } | undefined> {
	const bundle = autoTopupBundle(choice);
	if (!bundle) {
		console.error(`auto top-up paused for org ${orgId}: ${choice === null ? 'no bundle chosen' : 'stored bundle is not a configured option'}`);
		return;
	}
	const price = await getStripe().prices.retrieve(priceIdFor(bundle));
	if (!price.active || price.currency !== 'usd' || price.type !== 'one_time') {
		console.error(
			`auto top-up skipped for org ${orgId}: bundle ${bundle.id} price ${price.id} is not an active one-time USD price (active=${price.active}, currency=${price.currency}, type=${price.type})`
		);
		return;
	}
	const amount = price.unit_amount ?? 0;
	if (!amount) {
		console.error(`auto top-up skipped for org ${orgId}: bundle ${bundle.id} price has no unit_amount`);
		return;
	}
	return { bundle, amount };
}

export async function maybeTriggerAutoTopUp(orgId: string, diagnostics?: CronDiagnostics): Promise<boolean> {
	const org = await readAutoTopupState(orgId);
	if (!basicEligibility(org)) return false;
	// A surviving attempt marker means a previous charge may still be live at
	// Stripe even after the claim released: reconcile before minting a new
	// attempt. A PaymentIntent still in a nonterminal status defers this
	// charge — a second PI could double-charge when the first settles (codex
	// P1). Orgs with no marker have no prior attempt: skip the Stripe call.
	if (org.attemptAt && (await withTopupDiagnosticOperation(diagnostics, 'auto_topup.precharge_reconciliation', () => reconcileAutoTopup(orgId))).settling) {
		console.error(`auto top-up deferred for org ${orgId}: a previous payment is still in flight — not charging until it resolves`);
		return false;
	}
	const dayStart = `${startOfUtcDayIso(0)}T00:00:00.000Z`;
	const monthStart = `${startOfUtcDayIso(0).slice(0, 8)}01T00:00:00.000Z`;
	const dayCount = await topupCountsSince(orgId, dayStart);
	const monthCount = await topupCountsSince(orgId, monthStart);
	if (rateLimited(dayCount, monthCount)) return false;

	// Resolve the bundle and price BEFORE the atomic claim: a throw here
	// (missing env config, Stripe network/API error) must never leave the org
	// wedged in in_flight. The claim is taken only once a charge is about to be
	// attempted, so a failure here leaves the org idle for the next sweep.
	// Validate the configured Price BEFORE claiming: manual Checkout rejects
	// archived prices at session creation, but the auto-charge path copies
	// unit_amount and charges USD unconditionally — an archived, non-USD, or
	// recurring Price must never fund a differently denominated charge.
	const pricing = await withTopupDiagnosticOperation(diagnostics, 'auto_topup.price_lookup', () => resolveTopupPricing(orgId, org.bundle));
	if (!pricing) return false;
	const { bundle, amount } = pricing;

	// Atomic claim: exactly one concurrent caller wins the transition. The
	// claim RE-CHECKS eligibility (enabled flag, balance below threshold,
	// saved card) because the eligibility read above happened BEFORE the
	// price lookup: a manual Checkout grant or a disable can land in between,
	// and the claim must never charge a card the org no longer needs or has
	// just disabled (codex review).
	const claimNowIso = new Date().toISOString();
	// A surviving attempt marker is reused only while that attempt is still
	// inside the stale-claim window — the same-attempt retry path. The stale
	// sweep releases wedged claims without clearing the marker (it anchors
	// refund/recovery correlation), so an idle org can carry a marker older
	// than the window: reusing it would stamp a NEW PaymentIntent with the
	// dead attempt's idempotency key and auto_topup_attempt_at metadata —
	// repeated charges and ambiguous recovery correlation (gitar). A minted
	// attempt also starts UNSUBMITTED: retaining the dead attempt's
	// submittedAt would make a pause before the Stripe call record an
	// unresolved recovery for a payment that never reached Stripe (codex P2).
	const staleAttemptIso = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
	const mintsNewAttempt = sql`${organizations.autoTopupAttemptAt} IS NULL OR ${organizations.autoTopupAttemptAt} < ${staleAttemptIso}`;
	const nextAttempt = sql`CASE WHEN ${mintsNewAttempt} THEN ${claimNowIso} ELSE ${organizations.autoTopupAttemptAt} END`;
	const claimed = await db
		.update(organizations)
		.set({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: nextAttempt, autoTopupAttemptAt: nextAttempt,
			autoTopupSubmittedAt: sql`CASE WHEN ${mintsNewAttempt} THEN NULL ELSE ${organizations.autoTopupSubmittedAt} END` })
		.where(
			and(
				eq(organizations.id, orgId),
				eq(organizations.autoTopupState, 'idle'),
				eq(organizations.autoTopupEnabled, 1),
				eq(organizations.autoTopupBundle, bundle.id),
				// Mirror of UNMETERED_PLANS (ledger.ts): an org upgraded to
				// lifetime between the eligibility read and this claim must
				// never be charged for credits it cannot need (MOD-35).
				ne(organizations.plan, 'lifetime'),
				sql`${effectiveBalanceSql(claimNowIso)} < COALESCE(${organizations.autoTopupThreshold}, ${AUTO_TOPUP_DEFAULT_THRESHOLD})`,
				isNotNull(organizations.stripeCustomerId),
				isNotNull(organizations.stripeDefaultPmId)
			)
		)
		.returning({
			id: organizations.id,
			attemptAt: organizations.autoTopupAttemptAt,
			customerId: organizations.stripeCustomerId,
			defaultPmId: organizations.stripeDefaultPmId
		});
	if (claimed.length === 0) return false; // lost the race (or became ineligible mid-flight)

	// Use the identifiers captured BY THE CLAIM, not the earlier org read: a
	// payment method changed between the eligibility read and the claim must
	// never charge the stale pair (the claim re-checked isNotNull in SQL).
	const claim = claimed[0];
	const customerId = claim.customerId;
	const defaultPmId = claim.defaultPmId;
	if (!customerId || !defaultPmId) {
		// The claim re-checked isNotNull, so missing identifiers here is a bug:
		// release the in-flight claim and fail loudly instead of charging wrong.
		await db
			.update(organizations)
			.set({ autoTopupState: 'idle', autoTopupLastAttemptAt: null })
			.where(and(eq(organizations.id, orgId), eq(organizations.autoTopupState, 'in_flight')));
		throw new Error('auto top-up claim returned incomplete payment identifiers');
	}

	const attemptAt = claim.attemptAt;
	if (!attemptAt) throw new Error('auto top-up claim returned no logical attempt');
	const idempotencyKey = `autotopup:${customerId}:${attemptAt}`;
	let paymentCreated = false;
	let failureLabel = 'auto top-up charge preparation';
	try {
		const current = await readAutoTopupState(orgId);
		if (!hasCurrentTopupClaim(current, attemptAt)) {
			await db.update(organizations).set({ autoTopupState: 'idle' }).where(and(eq(organizations.id, orgId), eq(organizations.autoTopupState, 'in_flight'), eq(organizations.autoTopupAttemptAt, attemptAt)));
			return false;
		}
		// Persist possible submission BEFORE Stripe. Refunds atomically revoke
		// this predicate; infrastructure retries preserve the same logical attempt.
		const submitted = await db.update(organizations).set({ autoTopupSubmittedAt: sql`COALESCE(${organizations.autoTopupSubmittedAt}, ${new Date().toISOString()})` })
			.where(and(eq(organizations.id, orgId), eq(organizations.autoTopupState, 'in_flight'), eq(organizations.autoTopupEnabled, 1), eq(organizations.autoTopupAttemptAt, attemptAt)))
			.returning({ id: organizations.id });
		if (!submitted.length) {
			await db.update(organizations).set({ autoTopupState: 'idle' }).where(and(eq(organizations.id, orgId), eq(organizations.autoTopupState, 'in_flight'), eq(organizations.autoTopupAttemptAt, attemptAt)));
			return false;
		}
		const metadata = { type: 'auto_topup', org_id: orgId, bundle: bundle.id, auto_topup_attempt_day: attemptAt.slice(0, 10), auto_topup_attempt_at: attemptAt };
		failureLabel = 'auto top-up charge';
		const pi = await getStripe().paymentIntents.create(
			{
				amount,
				currency: 'usd',
				customer: customerId,
				payment_method: defaultPmId,
				off_session: true,
				confirm: true,
				metadata
			},
			{ idempotencyKey }
		);
		paymentCreated = true;
		failureLabel = 'auto top-up post-charge check';
		const payment = { ...pi, metadata };
		const canceled = await findPausedTopup(db, orgId, payment);
		if (canceled) {
			failureLabel = 'paused auto top-up recovery';
			await recoverPausedTopup(canceled, payment);
			return false;
		}
		console.info(`auto top-up initiated for org ${orgId}: bundle ${bundle.id} (${idempotencyKey})`);
		return true;
	} catch (error) {
		await handleAndReportTopupFailure(orgId, attemptAt, error, paymentCreated, { diagnostics, label: failureLabel });
		return false;
	}
}

/**
 * Records a failed auto-top-up attempt and updates the organization’s auto-top-up state.
 *
 * Authentication failures or repeated consecutive failures disable auto-top-up; otherwise, the organization returns to the idle state. Stale or duplicate failures are ignored.
 *
 * @param orgId - The organization associated with the failed payment
 * @param code - The Stripe failure or decline code
 * @param piCreatedMs - The PaymentIntent creation time in milliseconds, when available
 */
export async function recordAutoTopupFailure(orgId: string, code: string, piCreatedMs?: number): Promise<void> {
	const org = await readAutoTopupState(orgId);
	// Correlation: a payment_failed webhook carries the PI it belongs to, and
	// the claim stamps last_attempt_at at charge time. A failure for an OLDER
	// PI arriving during a NEWER claim's in-flight window must not poison the
	// new attempt's counter.
	if (piCreatedMs && org.lastAttemptAt) {
		const drift = Math.abs(piCreatedMs - Date.parse(org.lastAttemptAt));
		if (drift > 60_000) {
			console.error(
				'auto top-up failure for a stale attempt — ignored'
			);
			return;
		}
	}
	const isAuth =
		code === 'authentication_required' ||
		code === 'authentication_not_handled' ||
		code === 'requires_action' ||
		code.includes('authentication_required'); // legacy message-shaped callers
	const nextFailures = (org.failures ?? 0) + 1;
	const nextState = isAuth || nextFailures >= MAX_CONSECUTIVE_FAILURES ? 'disabled' : 'idle';
	// ONE conditional UPDATE: the atomic claim-to-failure transition. A
	// duplicate delivery (state already left in_flight) matches 0 rows and is
	// a no-op — the counter can never double-count, even with read-then-write
	// races between two concurrent deliveries.
	const updated = await db
		.update(organizations)
		.set({ autoTopupState: nextState, autoTopupFailures: nextFailures, autoTopupLastAttemptAt: new Date().toISOString(), autoTopupAttemptAt: null, autoTopupSubmittedAt: null })
		.where(and(eq(organizations.id, orgId), eq(organizations.autoTopupState, 'in_flight'), org.lastAttemptAt ? eq(organizations.autoTopupLastAttemptAt, org.lastAttemptAt) : isNull(organizations.autoTopupLastAttemptAt)))
		.returning({ id: organizations.id });
	if (updated.length === 0) {
		console.error('auto top-up failure arrived without an in-flight claim — ignored (duplicate or stale delivery)');
		return;
	}
	console.error('auto top-up payment failure recorded', { state: nextState, failures: nextFailures, authenticationRequired: isAuth });
}

/**
 * Handles payment_intent.payment_failed for an auto-top-up PI. Never retries
 * off-session — the customer must re-authenticate (fresh Checkout) or update
 * their card.
 */
export async function handleAutoTopupFailure(paymentIntentId: string): Promise<void> {
	const pi = await getStripe().paymentIntents.retrieve(paymentIntentId);
	if (pi.metadata?.type !== 'auto_topup') return; // not ours — ignore
	const orgId = pi.metadata?.org_id;
	if (!orgId) {
		console.error(`auto top-up PI ${paymentIntentId} has no org_id metadata`);
		return;
	}
	// decline_code first: it carries the SPECIFIC reason (authentication_required),
	// while `code` on a card decline is the generic 'card_declined'.
	const code = pi.last_payment_error?.decline_code ?? pi.last_payment_error?.code ?? 'payment_failed';
	// The PI's creation time correlates the failure to the claim it belongs to.
	await recordAutoTopupFailure(orgId, code, pi.created ? pi.created * 1000 : undefined);
}

/**
 * Applies credits for a valid succeeded auto-top-up PaymentIntent and releases the organization claim.
 *
 * @param orgId - The organization receiving the credits
 * @param pi - The PaymentIntent to validate and fulfill
 * @returns `true` if credits were applied, `false` if the PaymentIntent is invalid or was already fulfilled
 */
type AutoTopupPi = {
	id: string;
	status?: string | null;
	latest_charge?: string | { id: string } | null;
	/** Unix seconds — correlates a duplicate delivery to the claim it belongs to. */
	created?: number | null;
	metadata: Record<string, string> | null;
};

export async function grantAutoTopupCredits(orgId: string, pi: AutoTopupPi): Promise<boolean> {
	// The contract lives HERE, not with the callers: only a succeeded charge
	// of ours can be granted.
	if (pi.status !== 'succeeded') return false;
	if (pi.metadata?.type !== 'auto_topup') return false;
	if (pi.metadata?.org_id !== orgId) return false;
	const bundleId = pi.metadata?.bundle;
	if (!bundleId) {
		console.error(`stripe: auto-topup PI ${pi.id} has no bundle metadata`);
		return false;
	}
	const bundle = bundleById(bundleId);
	let applied: boolean;
	let canceled: Awaited<ReturnType<typeof findPausedTopup>>;
	try {
		({ applied, canceled } = await grantTopupInTransaction(orgId, pi, bundle.credits));
	} catch (error) {
		// The claim re-checks the plan before charging, but an upgrade to
		// lifetime can land between the off-session charge and this delivery:
		// the paid PI is refunded idempotently and the claim released —
		// never a retry storm against the unmetered-grant guard (review).
		if (!(error instanceof Error && error.message === UNMETERED_CREDIT_GRANT_ERROR)) throw error;
		await refundUngrantablePayment({
			paymentIntentId: pi.id,
			idempotencyKey: `refund:ungrantable:${pi.id}`,
			label: `auto-topup PI ${pi.id} for org ${orgId} succeeded but the org is unmetered`,
			orgId
		});
		await releaseClaimForPi(orgId, pi, true);
		return false;
	}
	if (!(await postGrantFollowup(orgId, pi, applied, canceled))) return false;
	// A refund/dispute may have beaten this grant's delivery: drain the
	// queued reversal in the same breath as the grant (codex 6153).
	const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined;
	if (chargeId) {
		const drained = await drainPendingReversals(chargeId);
		if (drained > 0) console.error(`stripe: auto-topup grant ${pi.id} immediately drained ${drained} pending reversal(s) for ${chargeId}`);
	}
	return true;
}

/**
 * Post-grant branches: a paused recovery wins over the grant (recover, then
 * retry the grant once the pause is gone); an unapplied grant on a SUCCEEDED
 * PI is a duplicate delivery — the grant already committed on the FIRST
 * delivery. That delivery's org-state reset may have failed (a crash between
 * the ledger commit and the state update), which would leave the claim
 * in_flight until the 72h stale-claim sweep and block auto top-up for three
 * days. Release the claim now — but ONLY when the in-flight claim belongs
 * to THIS PI (drift guard): a late duplicate delivery of an older PI must
 * never clear a NEWER claim (codex).
 *
 * @returns `true` when the grant committed and the caller should drain
 *   queued reversals, `false` for every non-grant outcome.
 */
async function postGrantFollowup(
	orgId: string,
	pi: AutoTopupPi,
	applied: boolean,
	canceled: Awaited<ReturnType<typeof findPausedTopup>>
): Promise<boolean> {
	if (canceled) {
		await recoverPausedTopup(canceled, pi);
		if (!(await findPausedTopup(db, orgId, pi))) return grantAutoTopupCredits(orgId, pi);
		return false;
	}
	if (!applied) {
		await releaseClaimForPi(orgId, pi);
		return false;
	}
	return true;
}

/**
 * The grant transaction: dedupe on the PI ref, defer to a paused recovery,
 * apply the ledger delta, then commit the claim release WITH the grant
 * before a refund can observe it — and release this payment's claim before
 * its refund pause can record overlap.
 */
async function grantTopupInTransaction(
	orgId: string,
	pi: AutoTopupPi,
	credits: number
): Promise<{ applied: boolean; canceled: Awaited<ReturnType<typeof findPausedTopup>> }> {
	return db.transaction(async (tx) => {
		const existing = await tx.select({ id: creditTransactions.id }).from(creditTransactions).where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.refType, 'payment_intent'), eq(creditTransactions.refId, pi.id))).get();
		if (existing) return { applied: false, canceled: undefined };
		const canceled = await findPausedTopup(tx, orgId, pi);
		if (canceled) return { applied: false, canceled };
		const applied = await applyLedgerDelta(tx, {
			orgId,
			delta: credits,
			reason: 'auto_topup',
			refType: 'payment_intent',
			refId: pi.id,
			paymentIntentId: pi.id,
			chargeId: typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined
		});
		// Commit claim release WITH the grant, before a refund can observe it.
		const correlation = topupAttemptCorrelation(pi, organizations.autoTopupLastAttemptAt);
		await tx.update(organizations).set({ autoTopupState: sql`CASE WHEN ${organizations.autoTopupState} = 'disabled' THEN 'disabled' ELSE 'idle' END`, autoTopupFailures: 0, autoTopupAttemptAt: null, autoTopupSubmittedAt: null })
			.where(and(eq(organizations.id, orgId), or(and(or(ne(organizations.autoTopupState, 'disabled'), isNull(organizations.autoTopupState)), or(eq(organizations.autoTopupState, 'idle'), isNull(organizations.autoTopupLastAttemptAt))), correlation)));
		// Release this payment's claim before its refund pause can record overlap.
		const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined;
		if (chargeId) await pauseForObservedStripeRefund(tx, orgId, chargeId, undefined, undefined, pi);
		return { applied, canceled: undefined };
	});
}

/**
 * Releases an in-flight auto top-up claim when a SUCCEEDED charge's duplicate
 * delivery proves the grant already committed (see grantAutoTopupCredits).
 * The claim is anchored to its PaymentIntent via the drift guard: the claim
 * stamps last_attempt_at at charge time, so a delivery whose PI creation
 * does not match the current claim (a newer charge is in flight) is left
 * untouched — the stale-claim sweep owns it.
 */
async function releaseClaimForPi(
	orgId: string,
	pi: { id: string; created?: number | null; metadata?: Record<string, string> | null },
	allowIdle = false
): Promise<void> {
	const correlation = topupAttemptCorrelation({ ...pi, metadata: pi.metadata ?? null }, organizations.autoTopupLastAttemptAt);
	if (!correlation) return; // cannot correlate — leave it for the stale sweep
	const org = await readAutoTopupState(orgId);
	if (org.state !== 'in_flight' && org.state !== 'disabled' && !(allowIdle && org.state === 'idle')) return;
	if (!org.lastAttemptAt) return;
	await db
		.update(organizations)
		.set({ autoTopupState: sql`CASE WHEN ${organizations.autoTopupState} = 'disabled' THEN 'disabled' ELSE 'idle' END`, autoTopupFailures: 0, autoTopupAttemptAt: null, autoTopupSubmittedAt: null })
		.where(and(eq(organizations.id, orgId), eq(organizations.autoTopupState, org.state), eq(organizations.autoTopupLastAttemptAt, org.lastAttemptAt), correlation));
}

/**
 * Recovers credits for recent successful auto-top-up payments whose webhook processing may have been missed.
 *
 * @returns `recovered` — payments granted; `inFlight` — a matching top-up PI
 *   is still in a non-terminal Stripe status (processing/requires_*): callers
 *   must not clear the row's reconciliation markers yet, or a PI that
 *   succeeds later with a lost webhook becomes undiscoverable (codex P1).
 *   `settling` — the subset that can still move money: every non-canceled
 *   status EXCEPT requires_payment_method (a declined PI is dead: it cannot
 *   settle without a re-confirmation this code never sends, so it must not
 *   gate new charges — gitar). A missing or never-before-seen status ON OUR
 *   OWN PIs fails loudly as an API contract violation rather than guessing
 *   settleability (codex PR #168/#169); unrelated PIs are never inspected.
 */
export async function reconcileAutoTopup(orgId: string): Promise<{ recovered: number; inFlight: boolean; settling: boolean }> {
	const org = await readAutoTopupState(orgId);
	if (!org.customerId) return { recovered: 0, inFlight: false, settling: false };
	const sinceSeconds = Math.floor((Date.now() - RECONCILE_WINDOW_MS) / 1000);
	const list = await getStripe().paymentIntents.list({
		customer: org.customerId,
		created: { gte: sinceSeconds },
		limit: 100
	});
	let granted = 0;
	let inFlight = false;
	let settling = false;
	let invalid: Error | undefined;
	for (const pi of list.data) {
		// Only OUR top-up PIs drive settle/grant decisions. The list is
		// customer-scoped, so unrelated PIs (manual Checkout purchases,
		// subscription invoices) are ignored entirely — status included
		// (gitar PR #169).
		const ours = pi.metadata?.type === 'auto_topup' && pi.metadata?.org_id === orgId;
		if (!ours) continue;
		// Validate at the boundary (I2): a missing or unrecognized status is
		// wrong-typed external data — the API call failed. The throw is
		// DEFERRED until every provably-safe grant in this page has
		// committed, so one bad item never stalls lost-webhook recovery of
		// a succeeded charge listed after it. Every caller path then logs
		// the failure loudly and retries next invocation.
		if (typeof pi.status !== 'string' || !KNOWN_PI_STATUSES.has(pi.status)) {
			invalid ??= new Error(`unrecognized PaymentIntent status ${JSON.stringify(pi.status)} on ${pi.id} — cannot tell whether it can still settle`);
			continue;
		}
		if (pi.status === 'succeeded') {
			if (await grantAutoTopupCredits(orgId, pi)) granted += 1;
			continue;
		}
		// A terminal (canceled) PI must not keep the row selected.
		if (pi.status !== 'canceled') {
			inFlight = true;
			if (pi.status !== DEAD_PI_STATUS) settling = true;
		}
	}
	if (invalid) throw invalid;
	if (granted > 0) {
		console.info(`auto top-up reconciliation granted ${granted} recovered charge(s) for org ${orgId}`);
	}
	return { recovered: granted, inFlight, settling };
}

/**
 * Processes a bounded batch of organizations eligible for automatic credit top-up.
 *
 * @param limit - Maximum number of organizations to process in this invocation
 * @param deadline - Optional epoch-ms deadline shared with the caller (the cron
 *   budget): checked before every org — each one may perform Stripe list/price/
 *   create calls with SDK retries, and the sweep must never eat the whole
 *   serverless window; an expired deadline stops the sweep early (the next
 *   cron invocation continues).
 * @returns The number of newly initiated top-ups
 */
export async function sweepAutoTopUp(limit = 5, deadline?: number, diagnostics = new CronDiagnostics()): Promise<number> {
	const recovering = await withDiagnosticOperation('auto_topup.paused_recovery', () => sweepPausedTopups(limit > 1 ? Math.floor(limit / 2) : limit, deadline, diagnostics));
	if (recovering >= limit) return 0;
	limit -= recovering;
	// Unstick stale in-flight claims first: a webhook delivery lost past
	// Stripe's 3-day retry horizon would otherwise wedge auto top-up forever.
	await withDiagnosticOperation('auto_topup.release_claims', () => releaseStaleTopupClaims());
	const reconcileCutoff = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
	const reconciled = await reconcileStaleLifetimeRows(limit, reconcileCutoff, deadline, diagnostics);
	const offeredBundles = configuredAutoTopupBundles().map((bundle) => bundle.id);
	await withDiagnosticOperation('auto_topup.paused_bundles', () => warnPausedTopupOrgs(offeredBundles));
	return triggerEligibleTopups(limit - reconciled, offeredBundles, reconcileCutoff, deadline, diagnostics);
}

async function releaseStaleTopupClaims(): Promise<void> {
	await db
		.update(organizations)
		.set({ autoTopupState: 'idle' })
		.where(
			and(
				eq(organizations.autoTopupState, 'in_flight'),
				or(
					isNull(organizations.autoTopupLastAttemptAt),
					sql`${organizations.autoTopupLastAttemptAt} < ${new Date(Date.now() - STALE_CLAIM_MS).toISOString()}`
				)
			)
		);
}

/**
 * Owed refunds outrank new charges: the stale-lifetime reconcile pass runs
 * FIRST on the shared budget. The set is finite and self-draining — a
 * processed row clears both selection markers, so the anomaly is gone
 * permanently within a few invocations while metered work simply waits (it
 * recurs anyway). Metered-first would let a perpetually full charge batch
 * starve these rows past the 7-day reconcile window with their paid charges
 * never refunded (codex P1).
 *
 * Selection is a surviving enabled flag OR a last-attempt timestamp inside
 * the reconcile window: claimLifetimeSlot clears the flag atomically at
 * grant, so the NORMAL upgrade path leaves enabled=0 rows whose only
 * surviving marker is the attempt timestamp — a flag-only predicate would
 * never discover their lost-webhook charges (codex P1).
 *
 * @returns The number of candidate rows selected — they share the sweep's
 *   bounded budget whether or not each was reconciled before the deadline.
 */
async function reconcileStaleLifetimeRows(limit: number, reconcileCutoff: string, deadline: number | undefined, diagnostics: CronDiagnostics): Promise<number> {
	const staleLifetime = await withDiagnosticOperation('auto_topup.lifetime_candidates', () => db
		.select({ id: organizations.id, enabled: organizations.autoTopupEnabled })
		.from(organizations)
		.where(
			and(
				eq(organizations.plan, 'lifetime'),
				or(eq(organizations.autoTopupEnabled, 1), sql`${organizations.autoTopupLastAttemptAt} >= ${reconcileCutoff}`)
			)
		)
		.orderBy(asc(organizations.autoTopupLastAttemptAt), asc(organizations.id))
		.limit(limit)
		.all());
	for (const row of staleLifetime) {
		if (deadline !== undefined && Date.now() >= deadline) break;
		try {
			const { inFlight } = await reconcileAutoTopup(row.id);
			// Advancement IS the budget fix: clearing both markers removes the
			// row from the candidate set forever — otherwise the same
			// reconciled row stays first in the ordering every invocation and
			// later rows wait until they age out (codex P1, cubic). But only
			// when nothing is still resolving at Stripe: a claimed top-up PI
			// still 'processing' can succeed later with its webhook lost —
			// clearing the marker now would make that charge undiscoverable
			// (codex P1, round 8). On a reconcile FAILURE the markers likewise
			// stay, so the row is retried next invocation instead of silently
			// aging out unrefunded.
			if (!inFlight) {
				const cleared = await db
					.update(organizations)
					.set({ autoTopupEnabled: 0, autoTopupState: 'idle', autoTopupLastAttemptAt: null })
					.where(and(eq(organizations.id, row.id), eq(organizations.plan, 'lifetime')))
					.returning({ id: organizations.id });
				if (cleared.length === 1 && row.enabled === 1) console.error(`auto top-up: cleared a stale enabled flag on lifetime org ${row.id}`);
			}
		} catch (error) {
			diagnostics.report('lifetime auto top-up reconciliation', error);
		}
	}
	return staleLifetime.length;
}

async function warnPausedTopupOrgs(offeredBundles: string[]): Promise<void> {
	const paused = await db.select({ n: count() }).from(organizations)
		.where(and(eq(organizations.autoTopupEnabled, 1), ne(organizations.plan, 'lifetime'),
			or(isNull(organizations.autoTopupBundle), not(inArray(organizations.autoTopupBundle, offeredBundles)))))
		.get();
	if (paused?.n) console.error(`auto top-up: ${paused.n} organizations paused until an owner chooses an available bundle`);
}

/**
 * Reconciles each eligible org's recent charges, then attempts its top-up,
 * one org at a time on the shared deadline budget (bounded, I10).
 *
 * @returns The number of newly initiated top-ups
 */
async function triggerEligibleTopups(limit: number, offeredBundles: string[], reconcileCutoff: string, deadline: number | undefined, diagnostics: CronDiagnostics): Promise<number> {
	const nowIso = new Date().toISOString();
	const rows = await withDiagnosticOperation('auto_topup.eligible_candidates', () => db
		.select({ id: organizations.id, bundle: organizations.autoTopupBundle, lastAttemptAt: organizations.autoTopupLastAttemptAt })
		.from(organizations)
		.where(
			and(
				eq(organizations.autoTopupEnabled, 1),
				eq(organizations.autoTopupState, 'idle'),
				// Paused legacy settings must not fill the charging batch. Keep
				// recent attempts discoverable for lost-webhook reconciliation.
				or(inArray(organizations.autoTopupBundle, offeredBundles),
					sql`${organizations.autoTopupLastAttemptAt} >= ${reconcileCutoff}`),
				// Mirror of the atomic claim's plan predicate: a lifetime org
				// with a stale enabled flag is skipped loudly downstream — but
				// it must never be SELECTED either, or enough stale rows fill
				// the bounded batch and starve metered orgs (I10, review).
				ne(organizations.plan, 'lifetime'),
				sql`${effectiveBalanceSql(nowIso)} < COALESCE(${organizations.autoTopupThreshold}, ${AUTO_TOPUP_DEFAULT_THRESHOLD})`,
				// A cardless org can never be charged (maybeTriggerAutoTopUp
				// returns false) — excluding it here keeps the bounded batch
				// full of chargeable orgs: otherwise N ineligible rows could
				// occupy the whole limit every invocation and starve everyone
				// else (I10 fairness). Never-attempted orgs sort first (SQLite
				// NULLs first in ASC), a natural fair rotation.
				isNotNull(organizations.stripeCustomerId),
				isNotNull(organizations.stripeDefaultPmId)
			)
		)
		.orderBy(asc(organizations.autoTopupLastAttemptAt), asc(organizations.id))
		.limit(limit)
		.all());
	let triggered = 0;
	for (const row of rows) {
		// Deadline guard: the sweep shares the cron's budget with moderation —
		// Stripe calls with SDK retries must never consume the whole window.
		// The remaining orgs wait for the next invocation (bounded, I10).
		if (deadline !== undefined && Date.now() >= deadline) {
			console.error(`auto top-up sweep stopped early for org ${row.id}: shared deadline expired — remaining orgs deferred to the next invocation`);
			break;
		}
		try {
			// Reconcile first: a lost webhook for a SUCCEEDED charge must grant
			// its credits before any new charge is considered (no double charge,
			// no lost money). Idempotent and cheap — one list call per org.
			const { inFlight, settling } = await withDiagnosticOperation('auto_topup.eligible_reconciliation', () => reconcileAutoTopup(row.id));
			if (!offeredBundles.includes(row.bundle ?? '') && !inFlight && row.lastAttemptAt) {
				// Once old payments are reconciled, release the bounded budget. A
				// concurrent setting/attempt must retain its reconciliation marker.
				await db.update(organizations).set({ autoTopupLastAttemptAt: null })
					.where(and(eq(organizations.id, row.id), eq(organizations.autoTopupLastAttemptAt, row.lastAttemptAt),
						row.bundle === null ? isNull(organizations.autoTopupBundle) : eq(organizations.autoTopupBundle, row.bundle),
						eq(organizations.autoTopupState, 'idle'), isNull(organizations.autoTopupAttemptAt)));
			}
			// A PaymentIntent still resolving at Stripe defers the new charge —
			// minting a sibling under a fresh key could double-charge when the
			// first settles (codex P1). Dead statuses (requires_payment_method)
			// pin the marker but cannot settle, so they don't defer (gitar).
			// maybeTriggerAutoTopUp re-checks this itself for non-sweep callers.
			if (settling) {
				console.error(`auto top-up deferred for org ${row.id}: a previous payment is still in flight — not charging until it resolves`);
			} else if (await withDiagnosticOperation('auto_topup.charge_preparation', () => maybeTriggerAutoTopUp(row.id, diagnostics))) triggered += 1;
		} catch (error) {
			diagnostics.report('eligible auto top-up reconciliation', error);
		}
	}
	return triggered;
}
