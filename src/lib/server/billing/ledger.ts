// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// Per-org credit ledger — the usage tab's source of truth and the billing
// gate for AI scoring. `organizations.credits_remaining` is authoritative;
// every mutation writes a credit_transactions row in the SAME transaction
// and the UNIQUE(org_id, ref_type, ref_id) anchor makes every operation
// idempotent (a comment is consumed once, a checkout session granted once —
// webhooks and retries can never double-apply).

import { and, eq, lt, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { creditTransactions, organizations } from '$lib/server/db/schema';

export type CreditReason = 'consume' | 'purchase' | 'auto_topup' | 'refund' | 'dispute' | 'adjust';
export type CreditRefType = 'comment' | 'checkout_session' | 'payment_intent' | 'charge' | 'dispute' | 'admin';

/** The DB surface the ledger needs; both `db` and a transaction satisfy it. */
export type LedgerHandle = Pick<typeof db, 'insert' | 'update' | 'select' | 'delete'>;

/**
 * Runs ledger mutations inside a transaction when the caller passed the bare
 * `db` (webhook paths): the insert + balance update must commit atomically or
 * a crash between them leaves the idempotency anchor committed with no
 * balance change — the retry would see "already applied" and lose the money.
 * When the caller already holds a transaction (the pipeline's staging tx),
 * the wrapper nests via libsql savepoints — supported, correct, and the
 * transaction's own rollback covers the nested statements.
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

/** Current credit balance of an org (0 when never seeded). */
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
 * Applies a ledger delta idempotently: inserts the transaction row first
 * (conflict = already applied → no-op), then mutates the balance in the same
 * transaction. Returns true when THIS call applied the delta.
 *
 * Ordering note: for grants the insert-first order is the safe one — a
 * duplicate delivery must never add credits twice, and a failed balance
 * update rolls the whole transaction back (the row dies with it).
 */
export async function applyLedgerDelta(
	handle: LedgerHandle,
	{ orgId, delta, reason, refType, refId, paymentIntentId, chargeId }: LedgerDelta
): Promise<boolean> {
	return inLedgerTx(handle, async (tx) => {
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
 * Consumes one credit for a staged comment, atomically and idempotently.
 * Returns true when THIS call charged the comment. When the balance is 0 the
 * comment stages free (rule decisions keep running at zero per product
 * choice) and no ledger row survives — the row is rolled back so the ledger
 * never records a delta the balance did not absorb.
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
 * Finds the positive grant(s) a Stripe charge or payment intent maps to —
 * the reversal anchor for refunds and disputes. Returns the total granted
 * credits for the org, or null when no grant matches.
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
		.where(and(match, sql`${creditTransactions.delta} > 0`))
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

/** The usage tab's headline numbers. */
export async function usageSummary(orgId: string): Promise<UsageSummary> {
	const remaining = await getCredits(orgId);
	const monthStart = monthStartIso();
	// "Used" means moderation consumption only: refund/dispute reversals are
	// also negative-delta rows, but they are money leaving the ledger, not
	// comments scored — summing every negative row would inflate the stats.
	const rows = await db
		.select({ delta: creditTransactions.delta, createdAt: creditTransactions.createdAt })
		.from(creditTransactions)
		.where(
			and(
				eq(creditTransactions.orgId, orgId),
				eq(creditTransactions.reason, 'consume'),
				lt(creditTransactions.delta, 0)
			)
		)
		.all();
	const lifetimeTotal = rows.reduce((sum, row) => sum + row.delta, 0);
	// `0 - total` (not unary minus) so an empty ledger reports 0, not -0.
	const usedLifetime = 0 - lifetimeTotal;
	const monthTotal = rows.filter((row) => gteIso(row.createdAt, monthStart)).reduce((sum, row) => sum + row.delta, 0);
	const usedThisMonth = 0 - monthTotal;
	return { remaining, usedLifetime, usedThisMonth };
}

/** `YYYY-MM-01T00:00:00.000Z` for the current UTC month — ISO strings compare lexicographically. */
export function monthStartIso(): string {
	const now = new Date();
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00.000Z`;
}

function gteIso(value: string, threshold: string): boolean {
	return value >= threshold;
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
