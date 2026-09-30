import { asc, eq } from 'drizzle-orm';
import { describe, expect, test, vi } from 'vitest';

import { countDbStatements, setupTestDb, testDb } from '$lib/server/testdb';
import { db } from '$lib/server/db';
import { creditTransactions, organizations, stripePendingReversals, stripeSubscriptionPeriods } from '$lib/server/db/schema';
import {
	applyLedgerDelta,
	assertCreditsPurchasable,
	consumeCredit,
	consumeCreditsBulk,
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

async function seedHostedPeriod(includedCredits: number, consumedCredits = 0, orgId = 'org-1'): Promise<void> {
	const now = Date.now();
	await testDb().db.insert(stripeSubscriptionPeriods).values({
		orgId,
		subscriptionId: `sub-${orgId}`,
		invoiceId: `in-${orgId}`,
		periodKey: `period-${orgId}`,
		periodStart: new Date(now - 60_000).toISOString(),
		periodEnd: new Date(now + 60_000).toISOString(),
		includedCredits,
		consumedCredits,
		status: 'paid'
	});
}

describe('drainPendingReversals crash-consistency', () => {
	test('a delayed grant drains an earlier refund without overriding newer consent', async () => {
		await seedOrg('org-1', 100);
		await queuePendingReversal('ch_1', 'refund', undefined, '2026-09-30T13:10:00.000Z');
		await testDb().db.update(organizations).set({ autoTopupEnabled: 1, autoTopupState: 'idle', autoTopupConsentedAt: '2026-09-30T13:11:00.000Z' }).where(eq(organizations.id, 'org-1'));
		await seedChargeGrant('ch_1');
		expect(await drainPendingReversals('ch_1')).toBe(1);
		expect(await getCredits('org-1')).toBe(0);
		expect(await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get()).toMatchObject({ autoTopupEnabled: 1, autoTopupState: 'idle' });
	});

	test('a delayed refund disables auto top-up in the transaction that removes its credits', async () => {
		await seedOrg('org-1', 100);
		await testDb().db.update(organizations).set({ autoTopupEnabled: 1, autoTopupState: 'idle' }).where(eq(organizations.id, 'org-1'));
		await seedChargeGrant('ch_1');
		await queuePendingReversal('ch_1', 'refund');
		expect(await drainPendingReversals('ch_1')).toBe(1);
		expect(await getCredits('org-1')).toBe(0);
		expect(await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get()).toMatchObject({ autoTopupEnabled: 0, autoTopupState: 'disabled', autoTopupPauseReason: 'refund' });
	});

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


	test('preserves a later dispute ID when the pending row already exists', async () => {
		await queuePendingReversal('ch_1', 'dispute');
		await queuePendingReversal('ch_1', 'dispute', 'disp_1');
		expect((await testDb().db.select().from(stripePendingReversals).get())?.disputeId).toBe('disp_1');
		await queuePendingReversal('ch_1', 'dispute', 'disp_2');
		expect((await testDb().db.select().from(stripePendingReversals).get())?.disputeId).toBe('disp_1');
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
		// 'dispute' sorts before 'refund' on the UNIQUE index: the dispute takes
		// 100 → 0, then the refund reversal floors at 0 — a refunded grant never
		// leaves a negative debt balance (disputes stay unbounded for won-restore).
		expect(await getCredits('org-1')).toBe(0);
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

describe('assertCreditsPurchasable', () => {
	test('passes for metered orgs, throws for the unmetered lifetime plan', async () => {
		// Credit checkout creation (Stripe AND Mercado Pago) must reject an
		// unlimited plan before planting an attempt — a lifetime org buying
		// credits pays real money for a balance it can never need (MOD-35).
		await seedOrg('org-1', null, null);
		await expect(assertCreditsPurchasable('org-1')).resolves.toBeUndefined();
		await seedOrg('org-2', 500, 'cus_1');
		await expect(assertCreditsPurchasable('org-2')).resolves.toBeUndefined();

		await testDb().db.update(organizations).set({ plan: 'lifetime' }).where(eq(organizations.id, 'org-1'));
		await expect(assertCreditsPurchasable('org-1')).rejects.toThrow(/lifetime/);
	});

	test('fails loudly for an unknown org', async () => {
		await expect(assertCreditsPurchasable('missing')).rejects.toThrow('org not found');
	});
});


describe('consumeCredit', () => {
	test('an unmetered (lifetime) org never consumes a credit, even holding a balance', async () => {
		// Unlimited scoring must not burn a stranded pre-upgrade balance 1 per
		// AI comment — no decrement, no ledger row. The MOD-36 decision: the
		// balance freezes until the org is metered again.
		await seedOrg('org-1', 500, 'cus_1');
		await testDb().db.update(organizations).set({ plan: 'lifetime' }).where(eq(organizations.id, 'org-1'));
		expect(await consumeCredit(db, 'org-1', 'comment-1')).toBe(false);
		const org = await testDb().db.select({ creditsRemaining: organizations.creditsRemaining }).from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.creditsRemaining).toBe(500);
		expect(await testDb().db.select().from(creditTransactions)).toHaveLength(0);
	});

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

describe('consumeCreditsBulk', () => {
	test('allocates subscription allowance before purchased credits and keeps retries covered', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Hosted', plan: 'hosted', creditsRemaining: 5 });
		await seedHostedPeriod(2);
		const refIds = ['a', 'b', 'c'];

		const first = await consumeCreditsBulk(db, 'org-1', 'comment', refIds);

		expect(first).toEqual({ charged: refIds, covered: [], uncharged: [], metered: true });
		const period = await testDb().db.select().from(stripeSubscriptionPeriods).get();
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		const rows = await testDb().db.select().from(creditTransactions).orderBy(asc(creditTransactions.id)).all();
		expect(period?.consumedCredits).toBe(2);
		expect(org?.creditsRemaining).toBe(4);
		expect(rows.map((row) => [row.refId, row.balanceAfter])).toEqual([['a', 5], ['b', 5], ['c', 4]]);

		const retry = await consumeCreditsBulk(db, 'org-1', 'comment', refIds);

		expect(retry).toEqual({ charged: [], covered: refIds, uncharged: [], metered: true });
		expect((await testDb().db.select().from(stripeSubscriptionPeriods).get())?.consumedCredits).toBe(2);
		expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.creditsRemaining).toBe(4);
		expect(await testDb().db.select().from(creditTransactions)).toHaveLength(3);
	});

	test('consumes the earliest-EXPIRING period first, not the newest-starting one', async () => {
		// codex: ordering by period_start DESC spent the newest period's
		// allowance first — the older period's included credits could expire
		// unused while the org burned fresh allowance it would have had anyway.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Hosted', plan: 'hosted', creditsRemaining: null });
		const now = Date.now();
		// A started earlier AND expires earlier (the renewal tail of an old
		// subscription); B started later and outlives A.
		await testDb().db.insert(stripeSubscriptionPeriods).values([
			{
				orgId: 'org-1',
				subscriptionId: 'sub-old',
				invoiceId: 'in-old',
				periodKey: 'period-old',
				periodStart: new Date(now - 30 * 86_400_000).toISOString(),
				periodEnd: new Date(now + 3_600_000).toISOString(),
				includedCredits: 10,
				consumedCredits: 0,
				status: 'paid'
			},
			{
				orgId: 'org-1',
				subscriptionId: 'sub-new',
				invoiceId: 'in-new',
				periodKey: 'period-new',
				periodStart: new Date(now - 86_400_000).toISOString(),
				periodEnd: new Date(now + 30 * 86_400_000).toISOString(),
				includedCredits: 10,
				consumedCredits: 0,
				status: 'paid'
			}
		]);

		const result = await consumeCreditsBulk(db, 'org-1', 'comment', ['a', 'b', 'c']);

		expect(result).toEqual({ charged: ['a', 'b', 'c'], covered: [], uncharged: [], metered: true });
		const periods = await testDb().db.select().from(stripeSubscriptionPeriods).orderBy(asc(stripeSubscriptionPeriods.id)).all();
		expect(periods.map((period) => [period.periodKey, period.consumedCredits])).toEqual([
			['period-old', 3], // expires first — consumed first
			['period-new', 0]
		]);
	});

	test('returns the ordered shortfall after using the available allowance and purchased credits', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Hosted', plan: 'hosted', creditsRemaining: 2 });
		await seedHostedPeriod(3, 2);
		const refIds = ['a', 'b', 'c', 'd'];

		const result = await consumeCreditsBulk(db, 'org-1', 'feedback', refIds);

		expect(result).toEqual({ charged: ['a', 'b', 'c'], covered: [], uncharged: ['d'], metered: true });
		expect((await testDb().db.select().from(stripeSubscriptionPeriods).get())?.consumedCredits).toBe(3);
		expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.creditsRemaining).toBe(0);
		expect(await testDb().db.select().from(creditTransactions)).toHaveLength(3);
	});

	test('deduplicates ref ids without changing their input order', async () => {
		await seedOrg('org-1', 5);

		const result = await consumeCreditsBulk(db, 'org-1', 'comment', ['first', 'second', 'first', 'third', 'second']);

		expect(result).toEqual({ charged: ['first', 'second', 'third'], covered: [], uncharged: [], metered: true });
		expect((await testDb().db.select().from(creditTransactions).orderBy(asc(creditTransactions.id)).all()).map((row) => row.refId)).toEqual([
			'first', 'second', 'third'
		]);
	});

	test('an unmetered org leaves all refs uncharged and writes no ledger rows', async () => {
		await seedOrg('org-1', 500);
		await testDb().db.update(organizations).set({ plan: 'lifetime' }).where(eq(organizations.id, 'org-1'));
		const refIds = ['a', 'b', 'c'];

		const result = await consumeCreditsBulk(db, 'org-1', 'comment', refIds);

		expect(result).toEqual({ charged: [], covered: [], uncharged: refIds, metered: false });
		expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.creditsRemaining).toBe(500);
		expect(await testDb().db.select().from(creditTransactions)).toHaveLength(0);
	});

	test('fails loudly when the organization is missing', async () => {
		await expect(consumeCreditsBulk(db, 'missing', 'comment', ['a'])).rejects.toThrow('org not found: missing');
	});

	test('an empty request returns empty groups without issuing statements', async () => {
		const { value, count } = await countDbStatements(testDb().db, () => consumeCreditsBulk(db, 'missing', 'comment', []));

		expect(value).toEqual({ charged: [], covered: [], uncharged: [] });
		expect(count).toBe(0);
	});

	test('statement count is independent of batch size from 3 to 300 refs', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-3', name: 'Hosted', plan: 'hosted', creditsRemaining: 1000 });
		await testDb().db.insert(organizations).values({ id: 'org-300', name: 'Hosted', plan: 'hosted', creditsRemaining: 1000 });
		await seedHostedPeriod(1000, 0, 'org-3');
		await seedHostedPeriod(1000, 0, 'org-300');
		const smallRefs = ['small-a', 'small-b', 'small-c'];
		const largeRefs = Array.from({ length: 300 }, (_, index) => `large-${index}`);

		const small = await countDbStatements(testDb().db, () => consumeCreditsBulk(db, 'org-3', 'comment', smallRefs));
		const large = await countDbStatements(testDb().db, () => consumeCreditsBulk(db, 'org-300', 'comment', largeRefs));

		expect(small.value.charged).toEqual(smallRefs);
		expect(large.value.charged).toEqual(largeRefs);
		expect(small.count).toBe(6);
		expect(large.count).toBe(small.count);
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

	test('an exhausted hosted period falls back to purchased overage', async () => {
		const periodStart = new Date(Date.now() - 60_000).toISOString();
		const periodEnd = new Date(Date.now() + 60_000).toISOString();
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Hosted', plan: 'hosted', creditsRemaining: 1 });
		await testDb().db.insert(stripeSubscriptionPeriods).values({ orgId: 'org-1', subscriptionId: 'sub-1', invoiceId: 'in-1', periodKey: 'period-1', periodStart, periodEnd, includedCredits: 1, consumedCredits: 1, status: 'paid' });
		expect(await consumeCredit(testDb().db, 'org-1', 'comment-1')).toBe(true);
		const period = await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in-1')).get();
		expect(period?.consumedCredits).toBe(1);
		expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.creditsRemaining).toBe(0);
		expect(await consumeCredit(testDb().db, 'org-1', 'comment-2')).toBe(false);
	});
	test('a lifetime org still counts its live paid subscription period — the comments were paid for, not refunded', async () => {
		// Cancel→lifetime during the wind-down: the hosted period row stays
		// 'paid' and inside its window, so its unconsumed included comments
		// belong in the balance — upgrading the plan must not hide them.
		const periodStart = new Date(Date.now() - 60_000).toISOString();
		const periodEnd = new Date(Date.now() + 60_000).toISOString();
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'LT', plan: 'lifetime', creditsRemaining: 100 });
		await testDb().db.insert(stripeSubscriptionPeriods).values({ orgId: 'org-1', subscriptionId: 'sub-1', invoiceId: 'in-1', periodKey: 'period-1', periodStart, periodEnd, includedCredits: 100, consumedCredits: 0, status: 'paid' });
		expect(await getCredits('org-1')).toBe(200);
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
