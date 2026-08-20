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

import { eq } from 'drizzle-orm';
import { describe, expect, test, vi } from 'vitest';

import { setupTestDb, testDb } from '$lib/server/testdb';
import { db } from '$lib/server/db';
import { creditTransactions, organizations, stripePendingReversals, stripeSubscriptionPeriods } from '$lib/server/db/schema';
import {
	applyLedgerDelta,
	consumeCredit,
	drainPendingReversals,
	findGrantForStripe,
	getCredits,
	listCreditTransactions,
	monthStartIso,
	orgIsMetered,
	queuePendingReversal,
	usageSummary
} from './ledger';

setupTestDb(['organizations', 'credit_transactions', 'stripe_events', 'stripe_pending_reversals', 'stripe_subscription_periods']);

async function seedOrg(orgId = 'org-1', credits: number | null = null, stripeCustomerId: string | null = null): Promise<void> {
	await testDb().db
		.insert(organizations)
		.values({ id: orgId, name: 'Test org', creditsRemaining: credits, stripeCustomerId });
}

/** Seeds a credit grant for a Stripe charge so findGrantForStripe matches it. */
async function seedChargeGrant(chargeId: string, orgId = 'org-1', credits = 100): Promise<void> {
	await testDb().db.insert(creditTransactions).values({
		orgId,
		delta: credits,
		reason: 'purchase',
		refType: 'charge',
		refId: chargeId,
		chargeId,
		balanceAfter: credits
	});
}

describe('drainPendingReversals crash-consistency', () => {
	test('a stop between the first and second reversal keeps the second obligation durable for a retry', async () => {
		// Both a refund AND a dispute can be pending for one charge (delayed
		// grant). The old code deleted EVERY pending row for the charge right
		// after the FIRST row's ledger mutation — a crash before the second
		// mutation erased its obligation. Each row must be deleted by its own
		// id inside the SAME transaction as its ledger mutation.
		//
		// Row order is NOT guaranteed (SQLite serves WHERE charge_id from the
		// UNIQUE(charge_id, reason) index — 'dispute' sorts before 'refund'),
		// so the assertions are order-independent: exactly one reversal is
		// applied, exactly one obligation survives, and they are different
		// reasons — nothing is lost.
		await seedOrg('org-1', 100);
		await seedChargeGrant('ch_1');
		await queuePendingReversal('ch_1', 'refund');
		await queuePendingReversal('ch_1', 'dispute');

		const realTx = testDb().db.transaction.bind(testDb().db);
		let calls = 0;
		const txSpy = vi.spyOn(testDb().db, 'transaction').mockImplementation(async (cb) => {
			calls += 1;
			if (calls === 1) return realTx(cb); // first row commits normally
			throw new Error('simulated process stop before row 2');
		});

		try {
			await expect(drainPendingReversals('ch_1')).rejects.toThrow('simulated process stop');
		} finally {
			txSpy.mockRestore();
		}

		const remaining = await testDb().db.select().from(stripePendingReversals).all();
		expect(remaining).toHaveLength(1); // the unprocessed obligation survives for a retry

		// Exactly ONE reversal was applied; the surviving obligation is the
		// OTHER reason — the crash lost nothing.
		const applied = await testDb()
			.db.select({ refType: creditTransactions.refType })
			.from(creditTransactions)
			.where(eq(creditTransactions.chargeId, 'ch_1'))
			.all();
		const appliedReasons = applied.filter((r) => r.refType === 'refund' || r.refType === 'dispute').map((r) => r.refType);
		expect(appliedReasons).toHaveLength(1);
		expect(appliedReasons[0]).not.toBe(remaining[0].reason);
		expect(await getCredits('org-1')).toBe(0);
	});

	test('deletes each applied row by its own id inside a transaction — never a bare db.delete of the whole charge', async () => {
		await seedOrg('org-1', 100);
		await seedChargeGrant('ch_1');
		await queuePendingReversal('ch_1', 'refund');
		await queuePendingReversal('ch_1', 'dispute');

		const deleteSpy = vi.spyOn(testDb().db, 'delete');
		try {
			await drainPendingReversals('ch_1');
		} finally {
			deleteSpy.mockRestore();
		}

		// All deletes must go through the per-row transactions (crash-safe);
		// a bare db.delete would have wiped both rows before both mutations.
		expect(deleteSpy).not.toHaveBeenCalled();
		expect(await testDb().db.select().from(stripePendingReversals).all()).toHaveLength(0);
		expect(await getCredits('org-1')).toBe(-100);
	});
});

describe('orgIsMetered', () => {
	test('an org with neither balance nor customer is unmetered (self-hosted / pre-billing)', async () => {
		await seedOrg('org-1', null, null);
		expect(await orgIsMetered('org-1')).toBe(false);
	});

	test('an org with a balance is metered even with no customer', async () => {
		await seedOrg('org-1', 500, null);
		expect(await orgIsMetered('org-1')).toBe(true);
	});

	test('an org with only a Stripe customer is unmetered (checkout opened, never purchased)', async () => {
		// A customer is created when Checkout OPENS — before any purchase.
		// Metering must be based on a successful credit purchase (a non-null
		// balance), never on customer existence: a cancelled/failed checkout
		// must not flip an unlimited org into the credit gate.
		await seedOrg('org-1', null, 'cus_1');
		expect(await orgIsMetered('org-1')).toBe(false);
	});

	test('a LIFETIME org is unmetered even after a credit purchase', async () => {
		// The lifetime hosted plan promises unlimited moderated comments (Terms
		// §6.1(c)). The Usage page lets any owner buy credit bundles, and the
		// first grant flips creditsRemaining from null to a number — metering
		// must consult the plan, or a lifetime org silently becomes a finite
		// balance that pauses AI scoring (codex review).
		await testDb().db.insert(organizations).values({
			id: 'org-1',
			name: 'Test org',
			plan: 'lifetime',
			creditsRemaining: 500,
			stripeCustomerId: 'cus_1'
		});
		expect(await orgIsMetered('org-1')).toBe(false);
	});

	test('fails loudly for an unknown org', async () => {
		await expect(orgIsMetered('missing')).rejects.toThrow('org not found');
	});
});


describe('consumeCredit', () => {
	test('charges one credit and records the row with the new balance', async () => {
		await seedOrg('org-1', 5);
		const charged = await consumeCredit(db, 'org-1', 'comment-1');
		expect(charged).toBe(true);
		expect(await getCredits('org-1')).toBe(4);
		const rows = await listCreditTransactions('org-1');
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ orgId: 'org-1', delta: -1, reason: 'consume', refType: 'comment', refId: 'comment-1' });
		expect(rows[0].balanceAfter).toBe(4);
	});

	test('is idempotent: the same comment is charged exactly once', async () => {
		await seedOrg('org-1', 5);
		expect(await consumeCredit(db, 'org-1', 'comment-1')).toBe(true);
		expect(await consumeCredit(db, 'org-1', 'comment-1')).toBe(false);
		expect(await getCredits('org-1')).toBe(4);
	});

	test('at balance 0 the comment is not charged and no ledger row survives', async () => {
		await seedOrg('org-1', 0);
		expect(await consumeCredit(db, 'org-1', 'comment-1')).toBe(false);
		expect(await getCredits('org-1')).toBe(0);
		expect(await listCreditTransactions('org-1')).toHaveLength(0);
	});

	test('an org with a null balance behaves as zero', async () => {
		await seedOrg('org-1', null);
		expect(await consumeCredit(db, 'org-1', 'comment-1')).toBe(false);
	});

	test('fails loudly for an unknown org', async () => {
		await expect(consumeCredit(db, 'missing', 'comment-1')).rejects.toThrow('org not found');
	});
});

describe('applyLedgerDelta', () => {
	test('grants credits and records the purchase row keyed by checkout session', async () => {
		await seedOrg('org-1', 0);
		const applied = await applyLedgerDelta(db, {
			orgId: 'org-1',
			delta: 500,
			reason: 'purchase',
			refType: 'checkout_session',
			refId: 'cs_123',
			paymentIntentId: 'pi_123',
			chargeId: 'ch_123'
		});
		expect(applied).toBe(true);
		expect(await getCredits('org-1')).toBe(500);
		const rows = await listCreditTransactions('org-1');
		expect(rows).toHaveLength(1);
		expect(rows[0].balanceAfter).toBe(500);
	});

	test('is idempotent: the same session never grants twice', async () => {
		await seedOrg('org-1', 0);
		expect(await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_123' })).toBe(true);
		expect(await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_123' })).toBe(false);
		expect(await getCredits('org-1')).toBe(500);
	});

	test('reverses credits (negative delta) idempotently', async () => {
		await seedOrg('org-1', 500);
		const applied = await applyLedgerDelta(db, { orgId: 'org-1', delta: -500, reason: 'refund', refType: 'charge', refId: 'ch_123' });
		expect(applied).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		expect(await applyLedgerDelta(db, { orgId: 'org-1', delta: -500, reason: 'refund', refType: 'charge', refId: 'ch_123' })).toBe(false);
		expect(await getCredits('org-1')).toBe(0);
	});

	test('fails loudly for an unknown org', async () => {
		await expect(applyLedgerDelta(db, { orgId: 'missing', delta: 100, reason: 'purchase', refType: 'checkout_session', refId: 'cs_x' })).rejects.toThrow('org not found');
	});
});

describe('findGrantForStripe', () => {
	test('finds a grant by payment intent id', async () => {
		await seedOrg('org-1', 0);
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1' });
		const match = await findGrantForStripe(db, { paymentIntentId: 'pi_1' });
		expect(match).toEqual({ orgId: 'org-1', credits: 2000 });
	});

	test('finds a grant by charge id', async () => {
		await seedOrg('org-1', 0);
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 100, reason: 'auto_topup', refType: 'payment_intent', refId: 'pi_2', paymentIntentId: 'pi_2', chargeId: 'ch_2' });
		const match = await findGrantForStripe(db, { chargeId: 'ch_2' });
		expect(match).toEqual({ orgId: 'org-1', credits: 100 });
	});

	test('never counts won-dispute restores (adjust) as part of the charge grant', async () => {
		// A refund must reverse what the charge ORIGINALLY granted — a restore
		// row (money that came back after a won dispute) is not part of it.
		await seedOrg('org-1', 0);
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'adjust', refType: 'dispute', refId: 'du_1', chargeId: 'ch_1' });
		const match = await findGrantForStripe(db, { chargeId: 'ch_1' });
		expect(match).toEqual({ orgId: 'org-1', credits: 2000 });
	});

	test('returns null when nothing matches', async () => {
		expect(await findGrantForStripe(db, { chargeId: 'ch_none' })).toBeNull();
	});

	test('never matches consumption rows', async () => {
		await seedOrg('org-1', 5);
		await consumeCredit(db, 'org-1', 'comment-1');
		expect(await findGrantForStripe(db, { paymentIntentId: 'pi_x', chargeId: 'ch_x' })).toBeNull();
	});
});

describe('usageSummary', () => {
	test('reports remaining, lifetime and this-month usage', async () => {
		await seedOrg('org-1', 3);
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 100, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1' });
		await consumeCredit(db, 'org-1', 'c1');
		await consumeCredit(db, 'org-1', 'c2');
		// A consumption from last month must not count into this month.
		await testDb().db.insert(creditTransactions).values({
			orgId: 'org-1',
			delta: -1,
			reason: 'consume',
			refType: 'comment',
			refId: 'c-old',
			createdAt: '2000-01-15T12:00:00.000Z'
		});
		await testDb().db
			.update(organizations)
			.set({ creditsRemaining: 2 })
			.where(eq(organizations.id, 'org-1'));
		const summary = await usageSummary('org-1');
		expect(summary.remaining).toBe(2);
		expect(summary.usedLifetime).toBe(3);
		expect(summary.usedThisMonth).toBe(2);
	});

	test('aggregates in SQL — never fetches every consume row into memory', async () => {
		// The usage page must stay bounded as the ledger grows: SUM over the
		// (org_id, created_at) index, not a lifetime row fetch + JS reduce.
		await seedOrg('org-1', 100);
		await consumeCredit(db, 'org-1', 'c1');
		await testDb().db.insert(creditTransactions).values({
			orgId: 'org-1',
			delta: -7,
			reason: 'consume',
			refType: 'comment',
			refId: 'c-old',
			createdAt: '2000-01-15T12:00:00.000Z'
		});
		const statements: string[] = [];
		const client = testDb().client;
		const originalExecute = client.execute.bind(client);
		client.execute = ((stmt: unknown) => {
			const sqlText = String((stmt as { sql?: string }).sql ?? stmt);
			statements.push(sqlText);
			return originalExecute(stmt as never);
		}) as never;
		let summary: { remaining: number; usedLifetime: number; usedThisMonth: number };
		try {
			summary = await usageSummary('org-1');
		} finally {
			client.execute = originalExecute;
		}

		expect(summary).toEqual({ remaining: 99, usedLifetime: 8, usedThisMonth: 1 });
		// The consumption totals must come from SUM() queries, and NO query may
		// fetch the full consume rows just to add them up.
		expect(statements.some((s) => s.includes('SUM('))).toBe(true);
		expect(statements.some((s) => s.includes('from `credit_transactions`') && !s.includes('SUM('))).toBe(false);
	});

	test('a refund/dispute reversal never inflates used credits', async () => {
		await seedOrg('org-1', 0);
		// 100 purchased, 2 consumed, then fully refunded (the -100 reversal).
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 100, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1' });
		await consumeCredit(db, 'org-1', 'c1');
		await consumeCredit(db, 'org-1', 'c2');
		await applyLedgerDelta(db, { orgId: 'org-1', delta: -100, reason: 'refund', refType: 'charge', refId: 'ch_1' });

		const summary = await usageSummary('org-1');
		// Only the two consumption rows count as "used" — the -100 refund
		// reversal is money leaving the ledger, not moderation usage.
		expect(summary.usedLifetime).toBe(2);
		expect(summary.usedThisMonth).toBe(2);
	});


	test('hosted consumption atomically uses the paid period before purchased overage', async () => {
		const periodStart = new Date(Date.now() - 60_000).toISOString();
		const periodEnd = new Date(Date.now() + 60_000).toISOString();
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Hosted', plan: 'hosted', creditsRemaining: 2 });
		await testDb().db.insert(stripeSubscriptionPeriods).values({
			orgId: 'org-1', subscriptionId: 'sub-1', invoiceId: 'in-1', periodKey: 'period-1',
			periodStart, periodEnd, includedCredits: 100, consumedCredits: 0, status: 'paid'
		});
		expect(await consumeCredit(testDb().db as never, 'org-1', 'comment-1')).toBe(true);
		const period = await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in-1')).get();
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(period?.consumedCredits).toBe(1);
		expect(org?.creditsRemaining).toBe(2);
		expect(await getCredits('org-1')).toBe(101);
	});
	test('a canceled hosted subscription remains metered instead of becoming free unlimited access', async () => {
		const periodStart = new Date(Date.now() - 60_000).toISOString();
		const periodEnd = new Date(Date.now() + 60_000).toISOString();
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Canceled', plan: 'free', stripeSubscriptionId: 'sub-1', stripeSubscriptionStatus: 'canceled' });
		await testDb().db.insert(stripeSubscriptionPeriods).values({ orgId: 'org-1', subscriptionId: 'sub-1', invoiceId: 'in-1', periodKey: 'period-1', periodStart, periodEnd, includedCredits: 100, consumedCredits: 0, status: 'paid' });
		expect(await orgIsMetered('org-1')).toBe(true);
		expect(await consumeCredit(testDb().db as never, 'org-1', 'comment-1')).toBe(true);
		expect(await getCredits('org-1')).toBe(99);
	});

	test('monthStartIso is the first of the current UTC month', () => {
		expect(monthStartIso()).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
	});

	test('zero usage for a fresh org', async () => {
		await seedOrg('org-1', 0);
		const summary = await usageSummary('org-1');
		expect(summary).toEqual({ remaining: 0, usedLifetime: 0, usedThisMonth: 0 });
	});
});
