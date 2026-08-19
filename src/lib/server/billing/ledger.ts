// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// Per-org credit ledger — the usage tab's source of truth and the billing
// gate for AI scoring. `organizations.credits_remaining` is authoritative;
// every mutation writes a credit_transactions row in the SAME transaction
// and the UNIQUE(org_id, ref_type, ref_id) anchor makes every operation
// idempotent (a comment is consumed once, a checkout session granted once —
// webhooks and retries can never double-apply).

import { and, eq, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { creditTransactions, organizations, stripePendingReversals } from '$lib/server/db/schema';

export type CreditReason = 'consume' | 'purchase' | 'auto_topup' | 'refund' | 'dispute' | 'adjust';
// 'refund' and 'dispute' are reversal refTypes anchored on the charge id —
// DISTINCT anchors on purpose: a dispute reversal, a won-dispute restore, and
// a later full refund each apply exactly once without blocking one another.
export type CreditRefType = 'comment' | 'checkout_session' | 'payment_intent' | 'charge' | 'refund' | 'dispute' | 'admin';

/** The DB surface the ledger needs; both `db` and a transaction satisfy it. */
export type LedgerHandle = Pick<typeof db, 'insert' | 'update' | 'select' | 'delete'>;

/**
 * Executes a ledger mutation within the available transaction context.
 *
 * @param handle - The database or transaction handle used for the mutation
 * @param run - The mutation callback to execute
 * @returns The value produced by the mutation callback
 */
async function inLedgerTx<T>(handle: LedgerHandle, run: (tx: LedgerHandle) => Promise<T>): Promise<T> {
	const withTx = (handle as { transaction?: (cb: (tx: LedgerHandle) => Promise<T>) => Promise<T> }).transaction;
	// .call(handle): drizzle's transaction() reads this.session — an unbound
	// method reference would crash on `this`.
	if (withTx) return withTx.call(handle, (tx) => run(tx as LedgerHandle));
	return run(handle);
}

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
}

const UNIQUE_TARGET: [typeof creditTransactions.orgId, typeof creditTransactions.refType, typeof creditTransactions.refId] = [
	creditTransactions.orgId,
	creditTransactions.refType,
	creditTransactions.refId
];

/**
 * Retrieves an organization's current credit balance.
 *
 * @param orgId - The organization identifier
 * @returns The remaining credit balance, treating a missing balance as zero
 */
export async function getCredits(orgId: string): Promise<number> {
	const row = await db
		.select({ creditsRemaining: organizations.creditsRemaining })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.get();
	if (!row) throw new Error(`org not found: ${orgId}`);
	return row.creditsRemaining ?? 0;
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

export async function orgIsMetered(orgId: string): Promise<boolean> {
	const row = await db
		.select({ creditsRemaining: organizations.creditsRemaining, plan: organizations.plan })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.get();
	if (!row) throw new Error(`org not found: ${orgId}`);
	if (UNMETERED_PLANS.has(row.plan)) return false;
	return row.creditsRemaining !== null;
}

/**
 * Applies a credit ledger adjustment exactly once.
 *
 * @returns `true` if this call applied the adjustment, `false` if it was already applied.
 */
export async function applyLedgerDelta(
	handle: LedgerHandle,
	{ orgId, delta, reason, refType, refId, paymentIntentId, chargeId }: LedgerDelta
): Promise<boolean> {
	return inLedgerTx(handle, async (tx) => {
		// Existence check first (mirrors consumeCredit): an unknown org is a
		// data bug and must fail loudly with the SAME message everywhere —
		// never surface the FK constraint error instead (the org FK is
		// defense-in-depth, not the primary guard).
		const org = await tx
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.id, orgId))
			.get();
		if (!org) throw new Error(`org not found: ${orgId}`);
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
		const updated = await tx
			.update(organizations)
			// COALESCE: pre-billing orgs carry NULL credits (I7 nullable-first);
			// NULL + delta would stay NULL forever, silently eating every grant.
			.set({ creditsRemaining: sql`COALESCE(${organizations.creditsRemaining}, 0) + ${delta}` })
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
 * Charges one available credit for a comment.
 *
 * @param orgId - The organization whose credits are charged
 * @param commentId - The comment associated with the charge
 * @returns `true` if this call charged the comment, `false` if it was already charged or no credit was available
 * @throws Error if the organization does not exist
 */
export async function consumeCredit(handle: LedgerHandle, orgId: string, commentId: string): Promise<boolean> {
	return inLedgerTx(handle, async (tx) => {
		// Existence check first: an unknown org is a data bug and must fail loudly,
		// not silently stage comments free.
		const org = await tx
			.select({ creditsRemaining: organizations.creditsRemaining })
			.from(organizations)
			.where(eq(organizations.id, orgId))
			.get();
		if (!org) throw new Error(`org not found: ${orgId}`);
		const inserted = await tx
			.insert(creditTransactions)
			.values({
				orgId,
				delta: -1,
				reason: 'consume',
				refType: 'comment',
				refId: commentId,
				balanceAfter: null
			})
			.onConflictDoNothing({ target: UNIQUE_TARGET })
			.returning({ id: creditTransactions.id });
		if (inserted.length === 0) return false; // already consumed — duplicate delivery
		const updated = await tx
			.update(organizations)
			.set({ creditsRemaining: sql`COALESCE(${organizations.creditsRemaining}, 0) - 1` })
			.where(and(eq(organizations.id, orgId), sql`COALESCE(${organizations.creditsRemaining}, 0) > 0`))
			.returning({ balance: organizations.creditsRemaining });
		if (updated.length === 0) {
			// Balance hit 0 concurrently — the comment stages free. Remove the row
			// so the ledger never shows a delta the balance did not absorb.
			await tx
				.delete(creditTransactions)
				.where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.refType, 'comment'), eq(creditTransactions.refId, commentId)));
			return false;
		}
		await tx
			.update(creditTransactions)
			.set({ balanceAfter: updated[0].balance })
			.where(eq(creditTransactions.id, inserted[0].id));
		return true;
	});
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
	// "Used" means moderation consumption only: refund/dispute reversals are
	// also negative-delta rows, but they are money leaving the ledger, not
	// comments scored — summing every negative row would inflate the stats.
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
export async function queuePendingReversal(chargeId: string, reason: 'refund' | 'dispute'): Promise<void> {
	await db.insert(stripePendingReversals).values({ chargeId, reason }).onConflictDoNothing();
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
	const pending = await db
		.select()
		.from(stripePendingReversals)
		.where(eq(stripePendingReversals.chargeId, chargeId))
		.all();
	let drained = 0;
	for (const row of pending) {
		const match = await findGrantForStripe(db, { chargeId });
		// The grant still has not landed — keep the obligation for the next
		// grant (the sweep drops rows whose grant never arrives).
		if (!match) continue;
		// A disputed customer must never be re-charged off-session — same
		// policy as reverseDispute, applied at drain time (the dispute event
		// found no org to disable when it arrived).
		if (row.reason === 'dispute') {
			await db
				.update(organizations)
				.set({ autoTopupEnabled: 0, autoTopupState: 'disabled' })
				.where(eq(organizations.id, match.orgId));
		}
		// Same anchors as reverseCharge: refType 'refund'/'dispute', refId =
		// charge id — a later won-dispute restore still finds the 'dispute'
		// reversal, and a later full refund applies on its own anchor.
		await applyLedgerDelta(db, {
			orgId: match.orgId,
			delta: -match.credits,
			// The table only ever holds 'refund' | 'dispute' (queuePendingReversal
			// types it), but the DB column reads back as string — narrow it.
			reason: row.reason === 'dispute' ? 'dispute' : 'refund',
			refType: row.reason === 'refund' ? 'refund' : 'dispute',
			refId: chargeId,
			chargeId
		});
		// Satisfied (whether applied now or by a concurrent path): the anchor
		// makes double-application impossible, so the obligation is done.
		await db.delete(stripePendingReversals).where(eq(stripePendingReversals.chargeId, chargeId));
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
