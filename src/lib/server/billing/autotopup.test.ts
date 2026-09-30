import { readFileSync } from 'node:fs';
import { format } from 'node:util';
import { env } from '$env/dynamic/private';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { setupTestDb, testDb } from '$lib/server/testdb';
import { creditTransactions, organizations, stripeSubscriptionPeriods, stripeAutoTopupRecoveries, stripeRefundObservations } from '$lib/server/db/schema';
import { applyLedgerDelta, getCredits, pauseAutoTopupForRefund } from '$lib/server/billing/ledger';
import { grantAutoTopupCredits, handleAutoTopupFailure, maybeTriggerAutoTopUp, readAutoTopupState, recordAutoTopupFailure, stripeErrorCode, sweepAutoTopUp } from './autotopup';
import { recoverPausedTopup, sweepPausedTopups } from './autoTopupRecovery';

const mocks = vi.hoisted(() => ({
	paymentIntentsCreate: vi.fn(),
	paymentIntentsRetrieve: vi.fn(),
	paymentIntentsList: vi.fn(),
	pricesRetrieve: vi.fn(),
	refundsCreate: vi.fn(), paymentIntentsCancel: vi.fn(), refundsRetrieve: vi.fn(), chargesList: vi.fn(), refundsList: vi.fn()
}));

vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => ({
		paymentIntents: { create: mocks.paymentIntentsCreate, retrieve: mocks.paymentIntentsRetrieve, list: mocks.paymentIntentsList, cancel: mocks.paymentIntentsCancel },
		prices: { retrieve: mocks.pricesRetrieve },
		refunds: { create: mocks.refundsCreate, retrieve: mocks.refundsRetrieve, list: mocks.refundsList },
		charges: { list: mocks.chargesList }
	})
}));
vi.mock('$env/dynamic/private', () => ({
	env: { STRIPE_PRICE_CREDITS_100: 'price_100', STRIPE_PRICE_CREDITS_500: 'price_500', STRIPE_PRICE_CREDITS_2000: 'price_2000' }
}));

setupTestDb(['organizations', 'credit_transactions', 'stripe_events', 'stripe_subscription_periods', 'stripe_auto_topup_recoveries', 'stripe_refund_observations']);

async function seedOrg(overrides: Record<string, unknown> = {}): Promise<void> {
	await testDb().db.insert(organizations).values({
		id: 'org-1',
		name: 'Org',
		creditsRemaining: 50,
		autoTopupEnabled: 1,
		autoTopupBundle: 'credits_500', autoTopupThreshold: 100,
		autoTopupState: 'idle',
		autoTopupFailures: 0,
		stripeCustomerId: 'cus_1',
		stripeDefaultPmId: 'pm_1',
		...overrides
	});
}

async function seedPeriod({
	includedCredits = 100,
	consumedCredits = 0,
	status = 'paid',
	periodStart = new Date(Date.now() - 60_000).toISOString(),
	periodEnd = new Date(Date.now() + 60_000).toISOString()
}: { includedCredits?: number; consumedCredits?: number; status?: string; periodStart?: string; periodEnd?: string } = {}) {
	await testDb().db.insert(stripeSubscriptionPeriods).values({
		orgId: 'org-1',
		subscriptionId: 'sub_1',
		invoiceId: 'in_1',
		periodKey: 'period_1',
		periodStart,
		periodEnd,
		includedCredits,
		consumedCredits,
		status
	});
}

async function orgRow() {
	const row = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	if (!row) throw new Error('org-1 was not seeded');
	return row;
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.paymentIntentsCreate.mockResolvedValue({ id: 'pi_new' });
	mocks.paymentIntentsList.mockResolvedValue({ data: [], has_more: false });
	mocks.pricesRetrieve.mockImplementation(async (id: string) => ({ id, unit_amount: id === 'price_2000' ? 6465 : 2040, active: true, currency: 'usd', type: 'one_time' }));
	mocks.refundsCreate.mockResolvedValue({ id: 're_1', status: 'succeeded' });
	mocks.chargesList.mockResolvedValue({ data: [{ id: 'ch_1', amount: 100, amount_refunded: 0 }] });
});

test('auto-top-up trigger documentation uses the effective balance', () => {
	const documentation = readFileSync(new URL('../../../../docs/stripe-auto-topup.md', import.meta.url), 'utf8');
	const trigger = documentation.split('\n').find((line) => line.startsWith('1. **Trigger:**'));
	expect(trigger).toContain('effective balance (purchased credits + unused active subscription allowance) < threshold');
});

test.each([false, true])('a delayed refund recovers completed replacement top-ups exactly once (later refund delivered first: %s)', async (laterRefundFirst) => {
	await seedOrg();
	const occurredAt = new Date(Date.now() - 60_000).toISOString();
	for (const id of ['pi_completed_1', 'pi_completed_2']) {
		await grantAutoTopupCredits('org-1', { id, status: 'succeeded', latest_charge: `ch_${id}`, metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' } });
	}
	await testDb().db.update(creditTransactions).set({ createdAt: new Date().toISOString() });
	await applyLedgerDelta(testDb().db, { orgId: 'org-1', delta: 100, reason: 'auto_topup', refType: 'payment_intent', refId: 'pi_older', paymentIntentId: 'pi_older' });
	await testDb().db.update(creditTransactions).set({ createdAt: new Date(Date.parse(occurredAt) - 60_000).toISOString() }).where(eq(creditTransactions.refId, 'pi_older'));
	if (laterRefundFirst) await pauseAutoTopupForRefund(testDb().db, 'org-1', new Date(Date.now() + 60_000).toISOString());
	await pauseAutoTopupForRefund(testDb().db, 'org-1', occurredAt);
	await pauseAutoTopupForRefund(testDb().db, 'org-1', occurredAt);
	expect(await testDb().db.select().from(stripeAutoTopupRecoveries)).toEqual(expect.arrayContaining([
		expect.objectContaining({ paymentIntentId: 'pi_completed_1', resolvedAt: null }),
		expect.objectContaining({ paymentIntentId: 'pi_completed_2', resolvedAt: null })
	]));
	expect(await testDb().db.select().from(stripeAutoTopupRecoveries)).toHaveLength(2);
	mocks.paymentIntentsRetrieve.mockImplementation(async (id: string) => ({ id, status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1' } }));
	expect(await sweepPausedTopups(10)).toBe(2);
	expect(mocks.refundsCreate.mock.calls.map(([args]) => args.payment_intent).sort()).toEqual(['pi_completed_1', 'pi_completed_2']);
	expect((await testDb().db.select().from(stripeAutoTopupRecoveries)).every(row => row.resolvedAt !== null)).toBe(true);
});

describe('maybeTriggerAutoTopUp', () => {
	test('a definitive invalid request releases the logical attempt for owner correction', async () => {
		await seedOrg();
		mocks.paymentIntentsCreate.mockRejectedValueOnce({ type: 'StripeInvalidRequestError', statusCode: 400, code: 'resource_missing' });
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(await orgRow()).toMatchObject({ autoTopupState: 'idle', autoTopupAttemptAt: null, autoTopupSubmittedAt: null });
	});

	test('charges the selected 2,000-credit bundle', async () => {
		await seedOrg({ autoTopupBundle: 'credits_2000' });
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(true);
		expect(mocks.pricesRetrieve).toHaveBeenCalledWith('price_2000');
		expect(mocks.paymentIntentsCreate.mock.calls[0][0]).toMatchObject({ amount: 6465, metadata: { bundle: 'credits_2000' } });
	});
	test.each([null, 'credits_100', 'unknown'])('pauses loudly for stored bundle %s without calling Stripe', async (bundle) => {
		await seedOrg({ autoTopupBundle: bundle });
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
			expect(log).toHaveBeenCalledWith(expect.stringContaining('bundle'));
			expect(mocks.pricesRetrieve).not.toHaveBeenCalled();
			expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
			expect((await orgRow()).autoTopupState).toBe('idle');
		} finally { log.mockRestore(); }
	});
	test('a bundle change during price lookup prevents charging the old selection', async () => {
		await seedOrg();
		mocks.pricesRetrieve.mockImplementationOnce(async () => {
			await testDb().db.update(organizations).set({ autoTopupBundle: 'credits_2000' }).where(eq(organizations.id, 'org-1'));
			return { id: 'price_500', unit_amount: 2040, active: true, currency: 'usd', type: 'one_time' };
		});
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
		expect((await orgRow()).autoTopupState).toBe('idle');
	});

	test('a definitive card failure ends the logical attempt before a later charge', async () => {
		await seedOrg({ creditsRemaining: 0 });
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			mocks.paymentIntentsCreate.mockRejectedValueOnce({ type: 'StripeCardError', code: 'card_declined' }).mockResolvedValueOnce({ id: 'pi_next' });
			expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
			vi.setSystemTime(new Date(Date.now() + 25 * 3600_000));
			expect(await maybeTriggerAutoTopUp('org-1')).toBe(true);
			expect(mocks.paymentIntentsCreate.mock.calls[1][1].idempotencyKey).not.toBe(mocks.paymentIntentsCreate.mock.calls[0][1].idempotencyKey);
		} finally { vi.useRealTimers(); }
	});
	test('a refund between infrastructure retries retains the indeterminate Stripe payment', async () => {
		await seedOrg({ creditsRemaining: 0 });
		mocks.paymentIntentsCreate.mockRejectedValueOnce(new Error('response lost after Stripe charged'));
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		const firstMetadata = mocks.paymentIntentsCreate.mock.calls[0][0].metadata;
		const select = testDb().db.select.bind(testDb().db);
		let reads = 0;
		const spy = vi.spyOn(testDb().db, 'select').mockImplementation((fields) => {
			const query = select(fields);
			if (fields && 'enabled' in fields) {
				const from = query.from.bind(query);
				query.from = (table: never) => {
					const builder = from(table);
					const get = builder.get.bind(builder);
					builder.get = async () => {
						if (++reads === 2) await pauseAutoTopupForRefund(testDb().db, 'org-1');
						return get();
					};
					return builder;
				};
			}
			return query;
		});
		try {
			expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		} finally { spy.mockRestore(); }
		const recovery = await testDb().db.select().from(stripeAutoTopupRecoveries).get();
		expect(recovery?.resolvedAt).toBeNull();
		expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
		const pi = { id: 'pi_indeterminate', status: 'succeeded', created: Math.floor(Date.now() / 1000), metadata: firstMetadata };
		mocks.paymentIntentsList.mockResolvedValueOnce({ data: [pi], has_more: false });
		await sweepPausedTopups(1);
		expect(mocks.refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: pi.id }), expect.anything());
		expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.resolvedAt).toEqual(expect.any(String));
	});

	test('a refund after a lost create response records recovery even while the claim is idle', async () => {
		await seedOrg({ creditsRemaining: 0 });
		mocks.paymentIntentsCreate.mockRejectedValueOnce(new Error('response lost'));
		await maybeTriggerAutoTopUp('org-1');
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		expect(await testDb().db.select().from(stripeAutoTopupRecoveries).get()).toMatchObject({ resolvedAt: null });
	});
	test('infrastructure retries reuse exactly the same Stripe parameters with the same idempotency key', async () => {
		await seedOrg({ creditsRemaining: 0 });
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			mocks.paymentIntentsCreate.mockRejectedValueOnce({ type: 'api_error', code: 'api_error' }).mockResolvedValueOnce({ id: 'pi_retry' });
			expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
			vi.setSystemTime(new Date(Date.now() + 60_000));
			expect(await maybeTriggerAutoTopUp('org-1')).toBe(true);
			expect(mocks.paymentIntentsCreate.mock.calls[1]).toEqual(mocks.paymentIntentsCreate.mock.calls[0]);
		} finally {
			vi.useRealTimers();
		}
	});







	test('a refund during payment creation refunds the charge and never grants replacement credits', async () => {
		await seedOrg({ creditsRemaining: 0 });
		const created = Math.floor(Date.now() / 1000);
		const pi = { id: 'pi_race', status: 'succeeded', created, metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' } };
		mocks.paymentIntentsCreate.mockImplementationOnce(async () => {
			await pauseAutoTopupForRefund(testDb().db, 'org-1');
			return pi;
		});
		await maybeTriggerAutoTopUp('org-1');
		expect(await grantAutoTopupCredits('org-1', pi)).toBe(false);
		expect(await getCredits('org-1')).toBe(0);
		expect(mocks.refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_race' }), expect.objectContaining({ idempotencyKey: 'refund:autotopup-paused:pi_race' }));
		expect(await orgRow()).toMatchObject({ autoTopupEnabled: 0, autoTopupState: 'disabled', autoTopupPauseReason: 'refund' });
	});


	test('charges the saved card off-session when below threshold, with an idempotency key', async () => {
		await seedOrg();

		const triggered = await maybeTriggerAutoTopUp('org-1');

		expect(triggered).toBe(true);
		expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
		const [params, options] = mocks.paymentIntentsCreate.mock.calls[0];
		expect(params).toMatchObject({
			amount: 2040,
			currency: 'usd',
			customer: 'cus_1',
			payment_method: 'pm_1',
			off_session: true,
			confirm: true,
			metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_500' }
		});
		expect(options.idempotencyKey).toBe(`autotopup:cus_1:${params.metadata.auto_topup_attempt_at}`);
		expect(params.metadata.auto_topup_attempt_at).toBe((await orgRow()).autoTopupLastAttemptAt);
		// The in-flight claim was placed atomically.
		expect((await orgRow()).autoTopupState).toBe('in_flight');
	});

	test('never triggers when the balance is at or above the threshold', async () => {
		await seedOrg({ creditsRemaining: 150 });
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	});

	test('unused subscription allowance satisfies the auto-top-up threshold and sweep', async () => {
		await seedOrg({ creditsRemaining: 0 });
		await seedPeriod({ includedCredits: 100 });

		expect((await readAutoTopupState('org-1')).allowanceRemaining).toBe(100);
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(await sweepAutoTopUp(5)).toBe(0);
		expect(mocks.pricesRetrieve).not.toHaveBeenCalled();
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	});

	test('sweep candidate filtering skips fully allowance-covered orgs within its limit', async () => {
		await seedOrg({ creditsRemaining: 0 });
		await seedPeriod({ includedCredits: 100 });
		await testDb().db.insert(organizations).values({
			id: 'org-2', name: 'Org 2', creditsRemaining: 0, autoTopupEnabled: 1, autoTopupBundle: 'credits_500', autoTopupThreshold: 100,
			autoTopupState: 'idle', stripeCustomerId: 'cus_2', stripeDefaultPmId: 'pm_2'
		});

		expect(await sweepAutoTopUp(1)).toBe(1);
		expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
		expect(mocks.paymentIntentsCreate.mock.calls[0][0]).toMatchObject({ customer: 'cus_2' });
	});

	test('99 unused subscription credits remains below threshold and permits a top-up', async () => {
		await seedOrg({ creditsRemaining: 0 });
		await seedPeriod({ includedCredits: 99 });

		expect((await readAutoTopupState('org-1')).allowanceRemaining).toBe(99);
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(true);
		expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
	});

	test.each([
		{ label: 'expired', period: { includedCredits: 100, periodEnd: new Date(Date.now() - 60_000).toISOString() } },
		{ label: 'refunded', period: { includedCredits: 100, status: 'refunded' } }
	])('$label subscription period does not contribute to the threshold', async ({ period }) => {
		await seedOrg({ creditsRemaining: 0 });
		await seedPeriod(period);

		expect((await readAutoTopupState('org-1')).allowanceRemaining).toBe(0);
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(true);
		expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
	});

	test('exactly 100 purchased credits with no allowance meets the threshold', async () => {
		await seedOrg({ creditsRemaining: 100 });

		expect((await readAutoTopupState('org-1')).allowanceRemaining).toBe(0);
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(mocks.pricesRetrieve).not.toHaveBeenCalled();
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	});

	test('never triggers when disabled', async () => {
		await seedOrg({ autoTopupEnabled: 0 });
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
	});

	test('never triggers while a charge is already in flight', async () => {
		await seedOrg({ autoTopupState: 'in_flight' });
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
	});

	test('a disabled state logs loudly and does not charge', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await seedOrg({ autoTopupState: 'disabled' });
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('disabled'));
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	test('never triggers without a saved card', async () => {
		await seedOrg({ stripeDefaultPmId: null });
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
	});

	test('never triggers for a lifetime org, even enabled and below threshold', async () => {
		// An enabled flag on an unmetered plan is a data anomaly (the org
		// upgraded while enabled): skip loudly BEFORE any Stripe call and
		// never take the claim — unlimited scoring needs no credits.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await seedOrg({ plan: 'lifetime' });
		try {
			expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
			expect(mocks.pricesRetrieve).not.toHaveBeenCalled();
			expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unmetered'));
			expect((await orgRow()).autoTopupState).toBe('idle');
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('the atomic claim re-checks the plan: upgrading to lifetime mid-flight never charges', async () => {
		// The org upgrades between the eligibility read and the claim — the
		// claim's plan predicate must reject it, or a lifetime org is charged
		// for credits it can never need.
		await seedOrg();
		mocks.pricesRetrieve.mockImplementation(async () => {
			await testDb().db
				.update(organizations)
				.set({ plan: 'lifetime' })
				.where(eq(organizations.id, 'org-1'));
			return { id: 'price_100', unit_amount: 500, active: true, currency: 'usd', type: 'one_time' };
		});
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	});

	test('respects the 24h cooldown after the last attempt', async () => {
		await seedOrg({ autoTopupLastAttemptAt: new Date().toISOString() });
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
	});

	test('respects the daily cap (1/day)', async () => {
		await seedOrg();
		await testDb().db.insert(creditTransactions).values({
			orgId: 'org-1',
			delta: 100,
			reason: 'auto_topup',
			refType: 'payment_intent',
			refId: 'pi_today',
			createdAt: new Date().toISOString()
		});
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
	});

	test('re-checks eligibility in the atomic claim: a manual grant above threshold mid-flight never charges', async () => {
		// The eligibility read (balance 50 < threshold 100) happens BEFORE the
		// price lookup. If a manual Checkout grant lands while prices.retrieve
		// is awaiting, the claim must NOT go through — the org no longer needs
		// the top-up (codex review).
		await seedOrg();
		mocks.pricesRetrieve.mockImplementation(async () => {
			await testDb().db
				.update(organizations)
				.set({ creditsRemaining: 5000 })
				.where(eq(organizations.id, 'org-1'));
			return { id: 'price_100', unit_amount: 500, active: true, currency: 'usd', type: 'one_time' };
		});

		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
		expect((await orgRow()).autoTopupState).toBe('idle'); // claim never taken
	});

	test('re-checks eligibility in the atomic claim: disabling auto top-up mid-flight never charges', async () => {
		// The owner turns auto top-up off while the price lookup is pending —
		// the claim must not charge a card the owner just disabled (codex
		// review).
		await seedOrg();
		mocks.pricesRetrieve.mockImplementation(async () => {
			// The UI's disable clears ONLY the flag (state stays 'idle' — the
			// claim's existing WHERE state='idle' check alone cannot catch it).
			await testDb().db
				.update(organizations)
				.set({ autoTopupEnabled: 0 })
				.where(eq(organizations.id, 'org-1'));
			return { id: 'price_100', unit_amount: 500, active: true, currency: 'usd', type: 'one_time' };
		});

		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
		// The disable won the race; the claim never overwrote it.
		expect((await orgRow()).autoTopupEnabled).toBe(0);
		expect((await orgRow()).autoTopupState).toBe('idle');
	});

	test('loses the atomic claim race without charging', async () => {
		// The org starts IDLE and is flipped to in_flight AFTER the initial
		// state read but BEFORE the conditional claim UPDATE — so the test
		// actually exercises the UPDATE ... WHERE state='idle' predicate.
		// Seeding in_flight directly returns at the early state guard and
		// would pass even if the claim predicate were removed (coderabbit).
		await seedOrg();
		mocks.pricesRetrieve.mockImplementation(async () => {
			await testDb().db
				.update(organizations)
				.set({ autoTopupState: 'in_flight' })
				.where(eq(organizations.id, 'org-1'));
			return { id: 'price_100', unit_amount: 500, active: true, currency: 'usd', type: 'one_time' };
		});
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	});

	test('a StripeCardError (card_declined) counts as a card failure', async () => {
		// stripe-node exposes ordinary card declines as type
		// 'StripeCardError' (the API's `card_error` value lives on
		// error.raw.type). Missing that type sent declines down the
		// infrastructure path — never counted, retried indefinitely instead
		// of disabling after two failures (codex 6156).
		await seedOrg();
		mocks.paymentIntentsCreate.mockRejectedValue(
			Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined', decline_code: 'generic_decline' })
		);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		const row = await orgRow();
		expect(row.autoTopupFailures).toBe(1);
		expect(row.autoTopupState).toBe('idle');
		errorSpy.mockRestore();
	});

	test('an infrastructure failure releases the claim WITHOUT the 24h cooldown', async () => {
		// A transport/API failure is not the customer's card: the claim goes
		// back to idle AND the attempt timestamp clears, so the next sweep can
		// retry immediately. Leaving the timestamp set would stall the org a
		// full day at the cooldown check (codex 6136).
		await seedOrg();
		mocks.paymentIntentsCreate.mockRejectedValue(
			Object.assign(new Error('stripe api timeout'), { type: 'StripeAPIError' })
		);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		const row = await orgRow();
		expect(row.autoTopupState).toBe('idle');
		expect(row.autoTopupFailures).toBe(0);
		expect(row.autoTopupLastAttemptAt).toBeNull();
		errorSpy.mockRestore();
	});

	test('counts top-ups in SQL — never loads every auto_topup row to filter in JS', async () => {
		// The cap check must push the createdAt predicate into SQL: a count
		// over the (org_id, created_at) index, never a full-row fetch plus a
		// JS filter that grows without bound (coderabbit).
		await seedOrg();
		await testDb().db.insert(creditTransactions).values({
			orgId: 'org-1',
			delta: 100,
			reason: 'auto_topup',
			refType: 'payment_intent',
			refId: 'pi_old',
			createdAt: '2000-01-15T12:00:00.000Z'
		});
		mocks.paymentIntentsCreate.mockRejectedValue(
			Object.assign(new Error('declined'), { type: 'StripeCardError', code: 'card_declined' })
		);
		const statements: string[] = [];
		const client = testDb().client;
		const originalExecute = client.execute.bind(client);
		client.execute = ((stmt: unknown) => {
			const sqlText = String((stmt as { sql?: string }).sql ?? stmt);
			statements.push(sqlText);
			return originalExecute(stmt as never);
		}) as never;
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await maybeTriggerAutoTopUp('org-1');
		} finally {
			client.execute = originalExecute;
		}
		errorSpy.mockRestore();
		// The cap checks must come from count() queries over the ledger, and
		// NO query may fetch credit_transactions rows without aggregating (the
		// 'auto_topup' reason is parameterized out of the SQL text).
		expect(statements.some((s) => /count\(/i.test(s))).toBe(true);
		expect(statements.some((s) => /from `credit_transactions`/.test(s) && !/count\(/i.test(s))).toBe(false);
	});

	test('skips when the configured Price is archived', async () => {
		// Manual Checkout rejects archived prices; the auto-charge path copies
		// unit_amount blindly — it must not charge against a dead price.
		await seedOrg();
		mocks.pricesRetrieve.mockResolvedValue({ id: 'price_100', unit_amount: 500, active: false, currency: 'usd', type: 'one_time' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
		expect((await orgRow()).autoTopupState).toBe('idle');
		errorSpy.mockRestore();
	});

	test('skips when the configured Price is not USD', async () => {
		// The charge is created in USD unconditionally — a non-USD price must
		// never be charged as if it were USD.
		await seedOrg();
		mocks.pricesRetrieve.mockResolvedValue({ id: 'price_100', unit_amount: 500, active: true, currency: 'brl', type: 'one_time' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	test('skips when the configured Price is recurring', async () => {
		await seedOrg();
		mocks.pricesRetrieve.mockResolvedValue({ id: 'price_100', unit_amount: 500, active: true, currency: 'usd', type: 'recurring' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	test('a price lookup failure never leaves the org wedged in in_flight', async () => {
		await seedOrg();
		mocks.pricesRetrieve.mockRejectedValue(new Error('stripe is down'));

		// The price lookup must happen BEFORE the atomic claim: a throw here
		// must not leave the org stuck in in_flight, which would silently stop
		// auto top-up until the 3-day stale-claim sweep unstuck it.
		await expect(maybeTriggerAutoTopUp('org-1')).rejects.toThrow('stripe is down');
		expect((await orgRow()).autoTopupState).toBe('idle');
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	});

	test('a create-time failure is recorded loudly and never retried immediately', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await seedOrg();
		// Stripe card failures carry type='card_error' + code on the error
		// object (never in the message).
		mocks.paymentIntentsCreate.mockRejectedValue({ type: 'card_error', code: 'card_declined', message: 'Your card was declined' });

		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		const org = await orgRow();
		expect(org.autoTopupState).toBe('idle'); // released for a later retry...
		expect(org.autoTopupFailures).toBe(1); // ...but the cooldown started
		expect(org.autoTopupLastAttemptAt).not.toBeNull();
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	test('a Stripe transport failure releases the claim WITHOUT counting as a decline', async () => {
		// Timeouts, outages, and rate limits are infrastructure problems, not
		// the customer's card — two of them must never disable auto top-up.
		await seedOrg();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.paymentIntentsCreate.mockRejectedValue({ type: 'api_error', code: 'api_error' });

		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		const org = await orgRow();
		expect(org.autoTopupState).toBe('idle'); // claim released for the next sweep
		expect(org.autoTopupFailures).toBe(0);
		errorSpy.mockRestore();
	});

	test('a create-time SCA failure (authentication_required code) disables auto top-up', async () => {
		await seedOrg();
		// Stripe errors carry the code on the error object, not in the message.
		mocks.paymentIntentsCreate.mockRejectedValue({ code: 'authentication_required', message: 'Your card requires authentication' });

		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect((await orgRow()).autoTopupState).toBe('disabled');
	});
});

describe('sweepPausedTopups', () => {
	test.each(['succeeded', 'pending'])('an existing full %s refund is reconciled without issuing another refund', async (status) => {
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const row = (await testDb().db.select().from(stripeAutoTopupRecoveries).get())!;
		mocks.chargesList.mockResolvedValueOnce({ data: [{ id: 'ch_1', amount: 100, amount_refunded: 100 }] });
		mocks.refundsList.mockResolvedValueOnce({ data: [{ id: 're_original', amount: 100, status }], has_more: false });
		expect(await recoverPausedTopup(row, { id: 'pi_original', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1' } })).toBe(status === 'succeeded');
		expect(mocks.refundsCreate).not.toHaveBeenCalled();
		expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.resolvedAt).toEqual(status === 'succeeded' ? expect.any(String) : null);
	});

	test.each([
		{ id: 're_incomplete', amount: 50, status: 'succeeded' },
		{ id: '', amount: 100, status: 'succeeded' },
		{ id: 're_failed', amount: 100, status: 'failed' }
	])('an unconfirmed existing full refund fails loudly without issuing another refund: %s', async (refund) => {
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const row = (await testDb().db.select().from(stripeAutoTopupRecoveries).get())!;
		mocks.chargesList.mockResolvedValueOnce({ data: [{ id: 'ch_1', amount: 100, amount_refunded: 100 }] });
		mocks.refundsList.mockResolvedValueOnce({ data: [refund], has_more: false });
		await expect(recoverPausedTopup(row, { id: 'pi_original', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1' } })).rejects.toThrow();
		expect(mocks.refundsCreate).not.toHaveBeenCalled();
		expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.resolvedAt).toBeNull();
	});

	test('payment lookup persists its next page across bounded sweep invocations', async () => {
		const attemptAt = new Date(Date.now() - 3600_000).toISOString();
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: attemptAt });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const later = Array.from({ length: 100 }, (_, i) => ({ id: `pi_later_${i}`, status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', auto_topup_attempt_at: new Date().toISOString() } }));
		mocks.paymentIntentsList.mockResolvedValueOnce({ data: later, has_more: true });
		expect(await sweepPausedTopups(1)).toBe(1);
		expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.paymentLookupCursor).toBe('pi_later_99');
		expect(mocks.refundsCreate).not.toHaveBeenCalled();
		const original = { id: 'pi_original', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', auto_topup_attempt_at: attemptAt } };
		mocks.paymentIntentsList.mockResolvedValueOnce({ data: [original], has_more: false });
		expect(await sweepPausedTopups(1)).toBe(1);
		expect(mocks.paymentIntentsList).toHaveBeenLastCalledWith(expect.objectContaining({ starting_after: 'pi_later_99', limit: 100 }));
		expect(mocks.refundsCreate).toHaveBeenCalledTimes(1);
		expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.resolvedAt).toEqual(expect.any(String));
	});

	test('cancellation for a different payment never resolves the recovery', async () => {
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const row = (await testDb().db.select().from(stripeAutoTopupRecoveries).get())!;
		mocks.paymentIntentsCancel.mockResolvedValueOnce({ id: 'pi_other', status: 'canceled' });
		await expect(recoverPausedTopup(row, { id: 'pi_expected', status: 'requires_action', metadata: { type: 'auto_topup', org_id: 'org-1' } })).rejects.toThrow('cancellation');
		expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.resolvedAt).toBeNull();
	});

	test('missing list-item correlation cannot hide a valid payment', async () => {
		const attemptAt = new Date().toISOString();
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: attemptAt });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const pi = { id: 'pi_valid', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', auto_topup_attempt_at: attemptAt } };
		mocks.paymentIntentsList.mockResolvedValueOnce({ data: [{ ...pi, id: 'pi_bad', metadata: { type: 'auto_topup', org_id: 'org-1' } }, pi], has_more: false });
		await sweepPausedTopups(1);
		expect(mocks.refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: pi.id }), expect.anything());
	});

	test('ambiguous legacy payments are never canceled or refunded', async () => {
		const attemptAt = new Date().toISOString();
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: attemptAt });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const pi = { id: 'pi_one', created: Math.floor(Date.parse(attemptAt) / 1000), status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', auto_topup_attempt_day: attemptAt.slice(0, 10) } };
		mocks.paymentIntentsList.mockResolvedValueOnce({ data: [pi, { ...pi, id: 'pi_two' }], has_more: false });
		await sweepPausedTopups(1);
		expect(mocks.refundsCreate).not.toHaveBeenCalled();
		expect(mocks.paymentIntentsCancel).not.toHaveBeenCalled();
		expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.resolvedAt).toBeNull();
	});

	test('recovery advances one persisted page per tick before choosing a payment', async () => {
		const attemptAt = new Date().toISOString();
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: attemptAt });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const pi = { id: 'pi_old', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', auto_topup_attempt_at: attemptAt } };
		mocks.paymentIntentsList.mockResolvedValueOnce({ data: [{ id: 'pi_new', status: 'succeeded', metadata: {} }], has_more: true });
		await sweepPausedTopups(1);
		expect(mocks.paymentIntentsList).toHaveBeenCalledTimes(1);
		mocks.paymentIntentsList.mockResolvedValueOnce({ data: [pi], has_more: false });
		await sweepPausedTopups(1);
		expect(mocks.paymentIntentsList.mock.calls[1][0]).toMatchObject({ starting_after: 'pi_new' });
		expect(mocks.refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: pi.id }), expect.anything());
	});

	test('customer deletion lookup uses its customer index', async () => {
		const index = await testDb().client.execute("PRAGMA index_info('stripe_auto_topup_recoveries_customer_idx')");
		expect(index.rows.map((row) => row.name)).toEqual(['customer_id', 'resolved_at']);
	});

	test('a payment refund can finish after its organization has been erased', async () => {
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		await testDb().db.delete(organizations).where(eq(organizations.id, 'org-1'));
		const pi = { id: 'pi_orphan', status: 'succeeded', created: Math.floor(Date.now() / 1000), metadata: { type: 'auto_topup', org_id: 'org-1' } };
		mocks.paymentIntentsList.mockResolvedValueOnce({ data: [pi], has_more: false });
		expect(await sweepPausedTopups(1)).toBe(1);
		expect(mocks.refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: pi.id }), expect.anything());
		expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.resolvedAt).toEqual(expect.any(String));
	});
	test('recovery diagnostics preserve percent tokens in external identifiers', async () => {
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const row = (await testDb().db.select().from(stripeAutoTopupRecoveries).get())!;
		mocks.paymentIntentsCancel.mockRejectedValueOnce(new Error('Stripe unavailable'));
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await expect(recoverPausedTopup(row, { id: 'pi_%s', status: 'requires_action', metadata: { type: 'auto_topup', org_id: row.orgId } })).rejects.toThrow('Stripe unavailable');
			expect(spy.mock.calls.map((args) => format(...args)).join('\n')).toContain('pi_%s');
		} finally { spy.mockRestore(); }
	});


	test('a later same-day payment is not recovered for an earlier exact attempt', async () => {
		const attemptAt = new Date(Date.now() - 3600_000).toISOString();
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: attemptAt });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const later = { id: 'pi_later', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100', auto_topup_attempt_day: attemptAt.slice(0, 10), auto_topup_attempt_at: new Date().toISOString() } };
		const original = { ...later, id: 'pi_original', metadata: { ...later.metadata, auto_topup_attempt_at: attemptAt } };
		mocks.paymentIntentsList.mockResolvedValueOnce({ data: [later, original], has_more: false });
		await sweepPausedTopups(1);
		expect(mocks.refundsCreate).toHaveBeenCalledTimes(1);
		expect(mocks.refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: original.id }), expect.anything());
	});

	test('payment lookup uses a composite organization and payment index', async () => {
		const index = await testDb().client.execute("PRAGMA index_info('stripe_auto_topup_recoveries_payment_idx')");
		expect(index.rows.map((r) => r.name)).toEqual(['org_id', 'payment_intent_id']);
	});

	test('deadline-skipped rows consume no sweep slots, while failed remote attempts consume one', async () => {
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		expect(await sweepPausedTopups(1, Date.now() - 1)).toBe(0);
		mocks.paymentIntentsList.mockRejectedValueOnce(new Error('Stripe unavailable'));
		expect(await sweepPausedTopups(1)).toBe(1);
	});

	test('a concurrent successful cancellation cannot be overwritten by a losing worker', async () => {
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const row = (await testDb().db.select().from(stripeAutoTopupRecoveries).get())!;
		mocks.paymentIntentsCancel.mockImplementationOnce(async () => {
			await testDb().db.update(stripeAutoTopupRecoveries).set({ resolvedAt: new Date().toISOString(), lastError: null }).where(eq(stripeAutoTopupRecoveries.id, row.id));
			throw new Error('another worker already canceled');
		});
		expect(await recoverPausedTopup(row, { id: 'pi_race', status: 'requires_action', metadata: { type: 'auto_topup', org_id: row.orgId } })).toBe(true);
		expect(await testDb().db.select().from(stripeAutoTopupRecoveries).get()).toMatchObject({ lastError: null, resolvedAt: expect.any(String) });
	});

	test('the test schema includes the pending recovery index', async () => {
		const indexes = await testDb().client.execute("PRAGMA index_list('stripe_auto_topup_recoveries')");
		expect(indexes.rows.map((r) => r.name)).toContain('stripe_auto_topup_recoveries_pending_idx');
	});
});

describe('recordAutoTopupFailure', () => {
	test('authentication_required disables auto top-up immediately (SCA cannot retry off-session)', async () => {
		await seedOrg({ autoTopupState: 'in_flight' });
		await recordAutoTopupFailure('org-1', 'authentication_required');
		const org = await orgRow();
		expect(org.autoTopupState).toBe('disabled');
		expect(org.autoTopupFailures).toBe(1);
	});

	test('two consecutive declines across separate attempts disable auto top-up', async () => {
		await seedOrg({ autoTopupState: 'in_flight' });
		await recordAutoTopupFailure('org-1', 'card_declined');
		// A later attempt re-claims (in_flight) before failing again.
		await testDb().db.update(organizations).set({ autoTopupState: 'in_flight' }).where(eq(organizations.id, 'org-1'));
		await recordAutoTopupFailure('org-1', 'insufficient_funds');
		expect((await orgRow()).autoTopupState).toBe('disabled');
	});

	test('a single decline leaves the state idle (cooldown only)', async () => {
		await seedOrg({ autoTopupState: 'in_flight' });
		await recordAutoTopupFailure('org-1', 'expired_card');
		expect((await orgRow()).autoTopupState).toBe('idle');
	});

	test('a duplicate failure delivery never increments the counter twice', async () => {
		// One transient webhook error, then Stripe retries the same event: the
		// first delivery records the failure (in_flight -> idle); the retry must
		// be a no-op, or two 5xx deliveries would disable auto top-up.
		await seedOrg({ autoTopupState: 'in_flight' });
		await recordAutoTopupFailure('org-1', 'card_declined');
		await recordAutoTopupFailure('org-1', 'card_declined');
		const org = await orgRow();
		expect(org.autoTopupFailures).toBe(1);
		expect(org.autoTopupState).toBe('idle');
	});

	test('a failure for an OLDER PI arriving during a newer claim is ignored', async () => {
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });
		// The failing PI was created 2 days ago — it belongs to a previous
		// attempt, not the current claim; counting it would poison the counter.
		const oldPiCreatedMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
		await recordAutoTopupFailure('org-1', 'card_declined', oldPiCreatedMs);
		const org = await orgRow();
		expect(org.autoTopupFailures).toBe(0);
		expect(org.autoTopupState).toBe('in_flight');
	});
});

describe('stripeErrorCode', () => {
	test('prefers the specific decline_code over the generic code', () => {
		// A card decline carries code='card_declined' PLUS the specific
		// decline_code — authentication_required must win, or an SCA-required
		// charge is misrouted to the ordinary-decline path.
		expect(stripeErrorCode({ code: 'card_declined', decline_code: 'authentication_required' })).toBe('authentication_required');
	});

	test('falls back to the code when no decline_code exists', () => {
		expect(stripeErrorCode({ code: 'card_declined' })).toBe('card_declined');
	});

	test('falls back to the message for non-object errors', () => {
		expect(stripeErrorCode(new Error('network down'))).toBe('network down');
	});
});

describe('handleAutoTopupFailure (webhook)', () => {
	test('an authentication_required DECLINE_CODE disables auto top-up even when the generic code is card_declined', async () => {
		await seedOrg({ autoTopupState: 'in_flight' });
		mocks.paymentIntentsRetrieve.mockResolvedValue({
			id: 'pi_9',
			metadata: { type: 'auto_topup', org_id: 'org-1' },
			created: Math.floor(Date.now() / 1000),
			last_payment_error: { code: 'card_declined', decline_code: 'authentication_required' }
		});
		await handleAutoTopupFailure('pi_9');
		expect((await orgRow()).autoTopupState).toBe('disabled');
		expect((await orgRow()).autoTopupFailures).toBe(1);
	});

	test('records the failure for our auto-topup PIs', async () => {
		await seedOrg({ autoTopupState: 'in_flight' });
		mocks.paymentIntentsRetrieve.mockResolvedValue({
			id: 'pi_9',
			metadata: { type: 'auto_topup', org_id: 'org-1' },
			last_payment_error: { code: 'authentication_required' }
		});
		await handleAutoTopupFailure('pi_9');
		expect((await orgRow()).autoTopupState).toBe('disabled');
	});

	test('ignores PIs that are not auto-topup charges', async () => {
		await seedOrg({ autoTopupState: 'in_flight' });
		mocks.paymentIntentsRetrieve.mockResolvedValue({ id: 'pi_9', metadata: {}, last_payment_error: { code: 'card_declined' } });
		await handleAutoTopupFailure('pi_9');
		expect((await orgRow()).autoTopupFailures).toBe(0);
	});

	test('a duplicate payment_failed delivery is a no-op after the first', async () => {
		await seedOrg({ autoTopupState: 'in_flight' });
		mocks.paymentIntentsRetrieve.mockResolvedValue({
			id: 'pi_9',
			metadata: { type: 'auto_topup', org_id: 'org-1' },
			last_payment_error: { code: 'card_declined' }
		});
		await handleAutoTopupFailure('pi_9');
		await handleAutoTopupFailure('pi_9'); // webhook retry
		expect((await orgRow()).autoTopupFailures).toBe(1);
	});
});

describe('sweepAutoTopUp', () => {
	test('a malformed payment item does not prevent cron from canceling the valid paused payment', async () => {
		await seedOrg({ creditsRemaining: 0 });
		await maybeTriggerAutoTopUp('org-1');
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const pi = { id: 'pi_new', status: 'requires_action', created: Math.floor(Date.now() / 1000), metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' } };
		mocks.paymentIntentsList.mockResolvedValueOnce({ data: [null, { ...pi, id: 'pi_bad', metadata: { ...pi.metadata, auto_topup_attempt_day: '2026-99-99' } }, pi], has_more: false });
		mocks.paymentIntentsCancel.mockResolvedValueOnce({ ...pi, status: 'canceled' });
		await sweepAutoTopUp(5);
		expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.resolvedAt).toEqual(expect.any(String));
		expect(mocks.paymentIntentsCancel).toHaveBeenCalledTimes(1);
	});

	test('the reported two-refund sequence leaves cron unable to charge again', async () => {
		await seedOrg({ creditsRemaining: 0 });
		for (const [id, credits] of [['1', 500], ['2', 100]] as const) {
			await applyLedgerDelta(testDb().db, { orgId: 'org-1', delta: credits, reason: 'purchase', refType: 'checkout_session', refId: `cs_${id}` });
		}
		await applyLedgerDelta(testDb().db, { orgId: 'org-1', delta: -500, reason: 'refund', refType: 'refund', refId: 'ch_1' });
		await applyLedgerDelta(testDb().db, { orgId: 'org-1', delta: -100, reason: 'refund', refType: 'refund', refId: 'ch_2' });
		expect(await sweepAutoTopUp(5)).toBe(0);
		expect(await getCredits('org-1')).toBe(0);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	});

	test('a pending compensation is persisted and resolved by retrieving the refund on a later cron tick', async () => {
		await seedOrg({ creditsRemaining: 0 });
		await maybeTriggerAutoTopUp('org-1');
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const pi = { id: 'pi_new', status: 'succeeded', created: Math.floor(Date.now() / 1000), metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' } };
		mocks.refundsCreate.mockResolvedValueOnce({ id: 're_pending', status: 'pending' });
		expect(await grantAutoTopupCredits('org-1', pi)).toBe(false);
		expect(await testDb().db.select().from(stripeAutoTopupRecoveries).get()).toMatchObject({ paymentIntentId: 'pi_new', refundId: 're_pending', resolvedAt: null });
		mocks.paymentIntentsRetrieve.mockResolvedValueOnce(pi);
		mocks.refundsRetrieve.mockResolvedValueOnce({ id: 're_pending', status: 'succeeded' });
		await sweepAutoTopUp(5);
		expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.resolvedAt).toEqual(expect.any(String));
		expect(mocks.refundsCreate).toHaveBeenCalledTimes(1);
		expect(await getCredits('org-1')).toBe(0);
	});

	test('cron cancels a paused payment when its success webhook never arrives', async () => {
		await seedOrg({ creditsRemaining: 0 });
		await maybeTriggerAutoTopUp('org-1');
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const pi = { id: 'pi_new', status: 'requires_action', created: Math.floor(Date.now() / 1000), metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' } };
		mocks.paymentIntentsList.mockResolvedValueOnce({ data: [pi], has_more: false });
		mocks.paymentIntentsCancel.mockResolvedValueOnce({ ...pi, status: 'canceled' });
		expect(await sweepAutoTopUp(5)).toBe(0);
		expect(mocks.paymentIntentsCancel).toHaveBeenCalledWith('pi_new', { cancellation_reason: 'requested_by_customer' });
		expect((await orgRow()).autoTopupEnabled).toBe(0);
	});

	test('triggers for every enabled org below its threshold, bounded by the limit', async () => {
		await seedOrg();
		await testDb().db.insert(organizations).values({
			id: 'org-2',
			name: 'Org 2',
			creditsRemaining: 10,
			autoTopupEnabled: 1,
			autoTopupBundle: 'credits_500', autoTopupThreshold: 100,
			autoTopupState: 'idle',
			stripeCustomerId: 'cus_2',
			stripeDefaultPmId: 'pm_2'
		});
		// org-3 is below threshold but NOT enabled — never charged.
		await testDb().db.insert(organizations).values({
			id: 'org-3',
			name: 'Org 3',
			creditsRemaining: 10,
			autoTopupEnabled: 0,
			autoTopupBundle: 'credits_500', autoTopupThreshold: 100,
			autoTopupState: 'idle',
			stripeCustomerId: 'cus_3',
			stripeDefaultPmId: 'pm_3'
		});

		const triggered = await sweepAutoTopUp(5);

		expect(triggered).toBe(2);
		expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(2);
	});

	test('a stale-enabled lifetime org is still reconciled: a missed paid top-up refunds and the flag clears', async () => {
		// The charge batch correctly excludes lifetime orgs — but a PI that
		// succeeded before the upgrade (its webhook lost) is still paid money
		// for unusable credits. Excluding the row from SELECTION entirely
		// would skip reconcileAutoTopup too, leaving the charge unrefunded
		// forever: reconciliation runs independently of charge eligibility,
		// and the stale flag is cleared durably (codex P1, round 3).
		await seedOrg({ plan: 'lifetime' }); // enabled=1 survived the upgrade, carded, balance below threshold
		mocks.paymentIntentsList.mockResolvedValue({
			data: [{
				id: 'pi_missed',
				status: 'succeeded',
				latest_charge: 'ch_missed',
				created: Math.floor(Date.now() / 1000),
				metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' }
			}]
		});

		expect(await sweepAutoTopUp(5)).toBe(0);

		expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_missed', metadata: { reason: 'ungrantable', org_id: 'org-1' } }, { idempotencyKey: 'refund:ungrantable:pi_missed' });
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
		const org = await orgRow();
		expect(org.autoTopupEnabled).toBe(0); // anomaly durably cleared
	});

	test('the stale-lifetime reconcile runs first on the shared budget and a processed row leaves the candidate set', async () => {
		// Owed refunds outrank new charges: the finite anomaly set drains
		// before metered work consumes the shared budget (codex P1/P2 —
		// metered-first with limit=0 capacity meant stale rows could starve
		// past the 7-day reconcile window unreconciled). A processed row also
		// clears its last-attempt marker so it can never re-enter the set —
		// otherwise the same front row re-reconciles every invocation and
		// later rows wait until they age out (cubic).
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await seedOrg({ plan: 'lifetime', autoTopupLastAttemptAt: new Date().toISOString() }); // org-1: stale flag + recent attempt
			await testDb().db.insert(organizations).values({
				id: 'org-2',
				name: 'Org 2',
				creditsRemaining: 10,
				autoTopupEnabled: 1,
				autoTopupBundle: 'credits_500', autoTopupThreshold: 100,
				autoTopupState: 'idle',
				stripeCustomerId: 'cus_2',
				stripeDefaultPmId: 'pm_2'
			});
			expect(await sweepAutoTopUp(1)).toBe(0); // the single slot goes to the stale row
			expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
			const org = await orgRow();
			expect(org.autoTopupEnabled).toBe(0);
			expect(org.autoTopupLastAttemptAt).toBeNull(); // advanced — can never be selected again
			// Next invocation: the stale set is empty, so the metered org
			// finally gets its slot.
			expect(await sweepAutoTopUp(1)).toBe(1);
			expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
			expect(mocks.paymentIntentsCreate.mock.calls[0][0]).toMatchObject({ customer: 'cus_2' });
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a stale lifetime row keeps its markers while a top-up PI is still processing', async () => {
		// A claimed charge still in-flight at upgrade resolves later at Stripe;
		// if the webhook is then lost, clearing the last-attempt marker now
		// would make the row undiscoverable forever — the customer stays
		// charged with neither credits nor a refund (codex P1). The markers
		// clear only once every matching PI is terminal.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			await seedOrg({ plan: 'lifetime', autoTopupLastAttemptAt: new Date().toISOString() });
			mocks.paymentIntentsList.mockResolvedValue({
				data: [{
					id: 'pi_processing',
					status: 'processing',
					latest_charge: 'ch_processing',
					created: Math.floor(Date.now() / 1000),
					metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' }
				}]
			});
			expect(await sweepAutoTopUp(5)).toBe(0);
			expect(mocks.refundsCreate).not.toHaveBeenCalled(); // nothing to refund yet
			let org = await orgRow();
			expect(org.autoTopupEnabled).toBe(1); // markers retained — still discoverable
			expect(org.autoTopupLastAttemptAt).not.toBeNull();

			// The PI resolves to succeeded; the webhook is lost; the next sweep
			// refunds it and only then does the row leave the candidate set.
			mocks.paymentIntentsList.mockResolvedValue({
				data: [{
					id: 'pi_processing',
					status: 'succeeded',
					latest_charge: 'ch_processing',
					created: Math.floor(Date.now() / 1000),
					metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' }
				}]
			});
			expect(await sweepAutoTopUp(5)).toBe(0);
			expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_processing', metadata: { reason: 'ungrantable', org_id: 'org-1' } }, { idempotencyKey: 'refund:ungrantable:pi_processing' });
			org = await orgRow();
			expect(org.autoTopupEnabled).toBe(0);
			expect(org.autoTopupLastAttemptAt).toBeNull();
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a lifetime org whose flag was cleared at upgrade is still reconciled', async () => {
		// claimLifetimeSlot clears autoTopupEnabled atomically with the plan
		// flip — the NORMAL upgrade path produces enabled=0 rows that a
		// flag-only selection misses; a PI that succeeded pre-upgrade (its
		// webhook lost) would then never be refunded (codex P1). A recent
		// last-attempt timestamp is the surviving marker.
		await seedOrg({ plan: 'lifetime', autoTopupEnabled: 0, autoTopupState: 'idle', autoTopupLastAttemptAt: new Date().toISOString() });
		mocks.paymentIntentsList.mockResolvedValue({
			data: [{
				id: 'pi_missed',
				status: 'succeeded',
				latest_charge: 'ch_missed',
				created: Math.floor(Date.now() / 1000),
				metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' }
			}]
		});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await sweepAutoTopUp(5)).toBe(0);
		} finally {
			errorSpy.mockRestore();
		}
		expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_missed', metadata: { reason: 'ungrantable', org_id: 'org-1' } }, { idempotencyKey: 'refund:ungrantable:pi_missed' });
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	});

	test('a flag-cleared lifetime org with an ancient last attempt is not reconciled — nothing left to find', async () => {
		// Older than reconcileAutoTopup's list window means Stripe cannot
		// return the PI either way — spending a list call on the row is pure
		// waste inside the shared budget (codex P1 boundary).
		await seedOrg({ plan: 'lifetime', autoTopupEnabled: 0, autoTopupState: 'idle', autoTopupLastAttemptAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() });
		expect(await sweepAutoTopUp(5)).toBe(0);
		expect(mocks.paymentIntentsList).not.toHaveBeenCalled();
	});

	test('a failing org does not stop the sweep', async () => {
		await seedOrg();
		await testDb().db.insert(organizations).values({
			id: 'org-2',
			name: 'Org 2',
			creditsRemaining: 10,
			autoTopupEnabled: 1,
			autoTopupBundle: 'credits_500', autoTopupThreshold: 100,
			autoTopupState: 'idle',
			stripeCustomerId: 'cus_2',
			stripeDefaultPmId: 'pm_2'
		});
		mocks.paymentIntentsCreate.mockRejectedValue(new Error('stripe is down'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const triggered = await sweepAutoTopUp(5);

		expect(triggered).toBe(0);
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	test('the sweep unsticks stale in-flight claims older than Stripe\'s retry horizon', async () => {
		// A webhook delivery lost past 3 days would wedge auto top-up forever.
		const stale = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: stale });

		const triggered = await sweepAutoTopUp(5);

		expect(triggered).toBe(1);
		expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
	});

	test('a fresh in-flight claim is NOT unstuck by the sweep', async () => {
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });

		const triggered = await sweepAutoTopUp(5);

		expect(triggered).toBe(0);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	});

	test('cardless enabled orgs never starve the sweep — eligible orgs are still reached', async () => {
		// 6 permanently ineligible orgs (enabled, below threshold, but no saved
		// card — maybeTriggerAutoTopUp returns false for them) plus ONE eligible
		// org. Without the card filters, a limit-5 sweep can select only
		// ineligible rows every invocation and never reach the chargeable one.
		for (let i = 2; i <= 7; i++) {
			await testDb().db.insert(organizations).values({
				id: `org-${i}`,
				name: `Org ${i}`,
				creditsRemaining: 10,
				autoTopupEnabled: 1,
				autoTopupBundle: 'credits_500', autoTopupThreshold: 100,
				autoTopupState: 'idle'
			});
		}
		await testDb().db.insert(organizations).values({
			id: 'org-8',
			name: 'Org 8',
			creditsRemaining: 10,
			autoTopupEnabled: 1,
			autoTopupBundle: 'credits_500', autoTopupThreshold: 100,
			autoTopupState: 'idle',
			stripeCustomerId: 'cus_8',
			stripeDefaultPmId: 'pm_8'
		});

		const triggered = await sweepAutoTopUp(5);

		expect(triggered).toBe(1);
		expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
	});

	test('an already-expired deadline stops the sweep before charging anyone', async () => {
		// The cron captures a shared deadline for moderation; a sweep that
		// ignored it could eat the whole serverless window.
		await seedOrg();
		const triggered = await sweepAutoTopUp(5, Date.now() - 1000);
		expect(triggered).toBe(0);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	});

	test('a deadline expiring mid-sweep stops after the current org', async () => {
		vi.useFakeTimers();
		try {
			await seedOrg(); // org-1 — eligible, with card
			await testDb().db.insert(organizations).values({
				id: 'org-2',
				name: 'Org 2',
				creditsRemaining: 10,
				autoTopupEnabled: 1,
				autoTopupBundle: 'credits_500', autoTopupThreshold: 100,
				autoTopupState: 'idle',
				stripeCustomerId: 'cus_2',
				stripeDefaultPmId: 'pm_2'
			});
			// The deadline expires while org-1 is being reconciled — the sweep
			// finishes org-1 and must NOT start org-2.
			mocks.paymentIntentsList.mockImplementation(async () => {
				vi.advanceTimersByTime(100_000);
				return { data: [] };
			});

			const triggered = await sweepAutoTopUp(5, Date.now() + 60_000);

			expect(triggered).toBe(1);
			expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test('a NULL balance (pre-billing org) is swept like a zero balance', async () => {
		await seedOrg({ creditsRemaining: null });

		const triggered = await sweepAutoTopUp(5);

		expect(triggered).toBe(1);
	});

	test('the sweep reconciles a succeeded charge whose webhook was lost before re-triggering', async () => {
		await seedOrg();
		// The claim was placed, the charge SUCCEEDED, the webhook was lost.
		mocks.paymentIntentsCreate.mockResolvedValue({ id: 'pi_recovered', status: 'succeeded' });
		mocks.paymentIntentsList.mockResolvedValue({
			data: [{ id: 'pi_recovered', status: 'succeeded', latest_charge: 'ch_recovered', metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' } }]
		});

		const triggered = await sweepAutoTopUp(5);

		// The recovered charge's credits are granted (50 seeded + 100 recovered)
		// and NO new charge is made (the balance is above the threshold).
		expect(await getCredits('org-1')).toBe(150);
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
		expect(triggered).toBe(0);
	});
});


describe('grantAutoTopupCredits', () => {
	test('missing payment correlation never grants credits while a canceled attempt is unresolved', async () => {
		await seedOrg({ creditsRemaining: 0 });
		await maybeTriggerAutoTopUp('org-1');
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		await expect(grantAutoTopupCredits('org-1', { id: 'pi_missing_time', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' } })).rejects.toThrow(/cannot be correlated/);
		expect(await getCredits('org-1')).toBe(0);
	});

	test('a delayed first success for an older payment preserves a newer in-flight claim', async () => {
		const now = new Date().toISOString();
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: now });
		expect(await grantAutoTopupCredits('org-1', { id: 'pi_old', status: 'succeeded', created: Math.floor(Date.now() / 1000) - 172800, metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' } })).toBe(true);
		expect(await getCredits('org-1')).toBe(150);
		expect(await orgRow()).toMatchObject({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: now });
	});

	test('failed compensation keeps a durable visible error and never grants credits', async () => {
		await seedOrg({ creditsRemaining: 0 });
		await maybeTriggerAutoTopUp('org-1');
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		mocks.refundsCreate.mockRejectedValueOnce(new Error('network unavailable'));
		const pi = { id: 'pi_new', status: 'succeeded', created: Math.floor(Date.now() / 1000), metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' } };
		await expect(grantAutoTopupCredits('org-1', pi)).rejects.toThrow('network unavailable');
		expect(await testDb().db.select().from(stripeAutoTopupRecoveries).get()).toMatchObject({ paymentIntentId: 'pi_new', resolvedAt: null, lastError: 'refund_or_cancellation_failed' });
		expect(await getCredits('org-1')).toBe(0);
		expect((await orgRow()).autoTopupState).toBe('disabled');
	});

	test('an older same-day payment cannot release a newer claim with an exact attempt identity', async () => {
		const now = new Date().toISOString();
		const old = new Date(Date.now() - 3600_000).toISOString();
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: now });
		expect(await grantAutoTopupCredits('org-1', { id: 'pi_old_day', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100', auto_topup_attempt_day: now.slice(0, 10), auto_topup_attempt_at: old } })).toBe(true);
		expect(await orgRow()).toMatchObject({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: now });
	});

	/** A succeeded auto-topup PI with a creation time near the claim. */
	function succeededPi(overrides: Partial<Parameters<typeof grantAutoTopupCredits>[1]> = {}): Parameters<typeof grantAutoTopupCredits>[1] {
		return {
			id: 'pi_1',
			status: 'succeeded',
			latest_charge: 'ch_1',
			created: Math.floor(Date.now() / 1000),
			metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' },
			...overrides
		};
	}

	test('a duplicate delivery releases the successful claim even when the grant already exists', async () => {
		// First delivery: the ledger grant committed, but the org-state update
		// crashed AFTER the commit. Stripe retries the delivery; applyLedgerDelta
		// returns false (already granted) and — without the release — the claim
		// would stay in_flight until the 72h stale-claim sweep, blocking auto
		// top-up for three days (codex review).
		await seedOrg({
			autoTopupState: 'in_flight',
			autoTopupFailures: 1,
			creditsRemaining: 150,
			// The claim was stamped at charge time — correlates with pi.created.
			autoTopupLastAttemptAt: new Date().toISOString()
		});
		// The grant already exists (first delivery committed it).
		await testDb().db.insert(creditTransactions).values({
			orgId: 'org-1',
			delta: 100,
			reason: 'auto_topup',
			refType: 'payment_intent',
			refId: 'pi_1',
			paymentIntentId: 'pi_1',
			chargeId: 'ch_1',
			balanceAfter: 150
		});

		const applied = await grantAutoTopupCredits('org-1', succeededPi());

		expect(applied).toBe(false); // duplicate — no double grant
		const org = await orgRow();
		expect(org.autoTopupState).toBe('idle'); // claim released for the next sweep
		expect(org.autoTopupFailures).toBe(0);
		expect(org.creditsRemaining).toBe(150); // credits untouched
	});

	test('a late duplicate of an OLD PI never clears a NEWER in-flight claim', async () => {
		// Stripe retries for up to 3 days; a duplicate delivery of a previous
		// PI can therefore arrive while a NEWER charge's claim is in flight.
		// The release must be anchored to the claim it belongs to (drift
		// guard) — clearing the newer claim would let two charges race.
		await seedOrg({ autoTopupState: 'in_flight', autoTopupFailures: 1 });
		await testDb().db.insert(creditTransactions).values({
			orgId: 'org-1',
			delta: 100,
			reason: 'auto_topup',
			refType: 'payment_intent',
			refId: 'pi_old',
			paymentIntentId: 'pi_old',
			chargeId: 'ch_old',
			balanceAfter: 150
		});
		// The OLD PI was created 2 days ago; the current claim is fresh.
		const oldPi = succeededPi({ id: 'pi_old', latest_charge: 'ch_old', created: Math.floor((Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000) });

		const applied = await grantAutoTopupCredits('org-1', oldPi);

		expect(applied).toBe(false);
		// The NEWER claim stays in_flight — untouched by the stale duplicate.
		const org = await orgRow();
		expect(org.autoTopupState).toBe('in_flight');
		expect(org.autoTopupFailures).toBe(1);
	});

	test('a top-up grant landing after the org went lifetime refunds the charge and releases the claim', async () => {
		// The claim re-checks the plan before charging, but an upgrade can
		// land between the off-session charge and this grant — the paid PI is
		// refunded (idempotent) and the claim released instead of throwing
		// forever against the unmetered-grant guard (review).
		await seedOrg({
			plan: 'lifetime',
			autoTopupState: 'in_flight',
			autoTopupLastAttemptAt: new Date().toISOString()
		});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await grantAutoTopupCredits('org-1', succeededPi())).toBe(false);
			expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_1', metadata: { reason: 'ungrantable', org_id: 'org-1' } }, { idempotencyKey: 'refund:ungrantable:pi_1' });
		} finally {
			errorSpy.mockRestore();
		}
		const org = await orgRow();
		expect(org.autoTopupState).toBe('idle');
		expect(org.creditsRemaining).toBe(50); // nothing granted
	});

	test('a top-up charge granted before the upgrade replays as a no-op — never a refund', async () => {
		// The grant committed while the org was metered; a duplicate delivery
		// arriving after the upgrade must dedup on the ledger anchor BEFORE
		// the unmetered guard runs — refunding it would claw back a completed
		// charge and leave the granted credits in place (codex P1).
		await seedOrg({ plan: 'lifetime', autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });
		await testDb().db.insert(creditTransactions).values({
			orgId: 'org-1',
			delta: 100,
			reason: 'auto_topup',
			refType: 'payment_intent',
			refId: 'pi_1',
			paymentIntentId: 'pi_1',
			chargeId: 'ch_1',
			balanceAfter: 150
		});
		expect(await grantAutoTopupCredits('org-1', succeededPi())).toBe(false);
		expect(mocks.refundsCreate).not.toHaveBeenCalled();
	});
});


test('legacy settings do not starve valid choices in the bounded sweep', async () => {
	await seedOrg({ autoTopupBundle: null });
	await testDb().db.insert(organizations).values({ id: 'org-2', name: 'Ready', creditsRemaining: 0, autoTopupEnabled: 1, autoTopupState: 'idle', autoTopupThreshold: 100, autoTopupBundle: 'credits_500', stripeCustomerId: 'cus_2', stripeDefaultPmId: 'pm_2' });
	expect(await sweepAutoTopUp(1)).toBe(1);
	expect(mocks.paymentIntentsCreate.mock.calls[0][0]).toMatchObject({ customer: 'cus_2', metadata: { bundle: 'credits_500' } });
});


test('an unconfigured saved bundle pauses before any Stripe call', async () => {
	await seedOrg({ autoTopupBundle: 'credits_2000' });
	const saved = env.STRIPE_PRICE_CREDITS_2000;
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		delete (env as Record<string, unknown>).STRIPE_PRICE_CREDITS_2000;
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('not a configured option'));
		expect(mocks.pricesRetrieve).not.toHaveBeenCalled();
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	} finally { env.STRIPE_PRICE_CREDITS_2000 = saved; log.mockRestore(); }
});

test('having only the retired bundle configured throws before claiming', async () => {
	await seedOrg();
	const saved500 = env.STRIPE_PRICE_CREDITS_500;
	const saved2000 = env.STRIPE_PRICE_CREDITS_2000;
	try {
		delete (env as Record<string, unknown>).STRIPE_PRICE_CREDITS_500;
		delete (env as Record<string, unknown>).STRIPE_PRICE_CREDITS_2000;
		await expect(maybeTriggerAutoTopUp('org-1')).rejects.toThrow('no eligible auto top-up bundle');
		expect((await orgRow()).autoTopupState).toBe('idle');
		expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	} finally { env.STRIPE_PRICE_CREDITS_500 = saved500; env.STRIPE_PRICE_CREDITS_2000 = saved2000; }
});


test('a legacy selection still reconciles paid historical 100-credit intents', async () => {
	await seedOrg({ autoTopupBundle: null, autoTopupLastAttemptAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
	mocks.paymentIntentsList.mockResolvedValue({ data: [{ id: 'pi_legacy', status: 'succeeded', created: Math.floor(Date.now() / 1000) - 25 * 3600, latest_charge: 'ch_legacy', metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' } }] });
	expect(await sweepAutoTopUp(1)).toBe(0);
	expect(await getCredits('org-1')).toBe(150);
	expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
	expect(await sweepAutoTopUp(1)).toBe(0);
	expect(await getCredits('org-1')).toBe(150);
});


test('reconciled legacy selections release the sweep budget on the next pass', async () => {
	await seedOrg({ autoTopupBundle: null, autoTopupLastAttemptAt: new Date(Date.now() - 48 * 3600_000).toISOString() });
	await testDb().db.insert(organizations).values({ id: 'org-2', name: 'Ready', creditsRemaining: 0, autoTopupEnabled: 1, autoTopupState: 'idle', autoTopupBundle: 'credits_500', autoTopupThreshold: 100, autoTopupLastAttemptAt: new Date(Date.now() - 25 * 3600_000).toISOString(), stripeCustomerId: 'cus_2', stripeDefaultPmId: 'pm_2' });
	expect(await sweepAutoTopUp(1)).toBe(0);
	expect(await sweepAutoTopUp(1)).toBe(1);
	expect(mocks.paymentIntentsCreate.mock.calls[0][0]).toMatchObject({ customer: 'cus_2' });
});

test('a failure arriving during a replaced claim cannot clear the newer attempt', async () => {
	const previous = '2026-09-30T10:00:00.000Z';
	const next = '2026-09-30T11:00:00.000Z';
	await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: previous, autoTopupAttemptAt: previous });
	const client = testDb().client;
	const execute = client.execute.bind(client);
	client.execute = (async (stmt: unknown) => {
		const text = String((stmt as { sql?: string }).sql ?? stmt);
		if (/update "organizations" set/i.test(text) && text.includes('auto_topup_failures')) await execute({ sql: 'UPDATE organizations SET auto_topup_last_attempt_at = ?, auto_topup_attempt_at = ? WHERE id = ?', args: [next, next, 'org-1'] });
		return execute(stmt as never);
	}) as never;
	try { await recordAutoTopupFailure('org-1', 'card_declined', Date.parse(previous)); }
	finally { client.execute = execute; }
	expect(await orgRow()).toMatchObject({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: next, autoTopupAttemptAt: next, autoTopupFailures: 0 });
});

test('disabling automatic top-up after claiming releases the unsubmitted claim', async () => {
	await seedOrg();
	const client = testDb().client;
	const execute = client.execute.bind(client);
	client.execute = (async (stmt: unknown) => {
		const text = String((stmt as { sql?: string }).sql ?? stmt);
		const result = await execute(stmt as never);
		if (/update "organizations" set/i.test(text) && text.includes('COALESCE') && text.includes('returning')) await execute("UPDATE organizations SET auto_topup_enabled = 0 WHERE id = 'org-1'");
		return result;
	}) as never;
	try { expect(await maybeTriggerAutoTopUp('org-1')).toBe(false); }
	finally { client.execute = execute; }
	expect(await orgRow()).toMatchObject({ autoTopupState: 'idle', autoTopupSubmittedAt: null });
	expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
});

test.each([false, true])('an early partial refund excludes its own top-up while recovering replacements (replacement: %s)', async (replacement) => {
	const attemptAt = new Date().toISOString();
	await seedOrg({ autoTopupState: 'in_flight', autoTopupAttemptAt: attemptAt, autoTopupLastAttemptAt: attemptAt, autoTopupSubmittedAt: attemptAt });
	if (replacement) await applyLedgerDelta(testDb().db, { orgId: 'org-1', delta: 100, reason: 'auto_topup', refType: 'payment_intent', refId: 'pi_replacement', paymentIntentId: 'pi_replacement', chargeId: 'ch_replacement' });
	await testDb().db.insert(stripeRefundObservations).values({ chargeId: 'ch_partial', refundedAmountCents: 100, occurredAt: attemptAt });
	await grantAutoTopupCredits('org-1', { id: 'pi_partial', status: 'succeeded', latest_charge: 'ch_partial', metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_500', auto_topup_attempt_at: attemptAt } } as never);
	expect(await getCredits('org-1')).toBe(replacement ? 650 : 550);
	expect(await orgRow()).toMatchObject({ autoTopupEnabled: 0, autoTopupState: 'disabled' });
	expect((await testDb().db.select().from(stripeAutoTopupRecoveries)).map(row => row.paymentIntentId)).toEqual(replacement ? ['pi_replacement'] : []);
});

test('a retrieved pagination candidate must be the exact payment selected earlier', async () => {
	const attemptAt = new Date().toISOString();
	await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: attemptAt });
	await pauseAutoTopupForRefund(testDb().db, 'org-1');
	const pi = { id: 'pi_expected', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', auto_topup_attempt_at: attemptAt } };
	mocks.paymentIntentsList.mockResolvedValueOnce({ data: [pi], has_more: true });
	await sweepPausedTopups(1);
	expect(mocks.refundsCreate).not.toHaveBeenCalled();
	mocks.paymentIntentsList.mockResolvedValueOnce({ data: [], has_more: false });
	mocks.paymentIntentsRetrieve.mockResolvedValueOnce({ ...pi, id: 'pi_other' });
	await sweepPausedTopups(1);
	expect(mocks.refundsCreate).not.toHaveBeenCalled();
	expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.paymentIntentId).toBeNull();
});

test('older pagination progress cannot erase ambiguity recorded by a concurrent worker', async () => {
	await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });
	await pauseAutoTopupForRefund(testDb().db, 'org-1');
	mocks.paymentIntentsList.mockResolvedValueOnce({ data: [{ id: 'pi_new', status: 'succeeded', metadata: {} }], has_more: true });
	const client = testDb().client;
	const execute = client.execute.bind(client);
	client.execute = (async (stmt: unknown) => {
		const text = String((stmt as { sql?: string }).sql ?? stmt);
		if (/update "stripe_auto_topup_recoveries" set "payment_lookup_cursor"/i.test(text)) await execute("UPDATE stripe_auto_topup_recoveries SET last_error = 'ambiguous_payment'");
		return execute(stmt as never);
	}) as never;
	try { await sweepPausedTopups(1); } finally { client.execute = execute; }
	expect(await testDb().db.select().from(stripeAutoTopupRecoveries).get()).toMatchObject({ lastError: 'ambiguous_payment', paymentLookupCursor: null });
});

test('an invalid-request response naming a possibly created payment retains its recovery identity', async () => {
	await seedOrg();
	mocks.paymentIntentsCreate.mockRejectedValueOnce({ type: 'StripeInvalidRequestError', statusCode: 400, code: 'resource_missing', raw: { payment_intent: { id: 'pi_uncertain' } } });
	await maybeTriggerAutoTopUp('org-1');
	expect(await orgRow()).toMatchObject({ autoTopupAttemptAt: expect.any(String), autoTopupSubmittedAt: expect.any(String) });
});

test('every recovery Stripe request uses the remaining deadline without retries', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	try {
		vi.setSystemTime('2026-09-30T13:10:00.000Z');
		const attemptAt = new Date().toISOString();
		await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: attemptAt });
		await pauseAutoTopupForRefund(testDb().db, 'org-1');
		const pi = { id: 'pi_budget', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', auto_topup_attempt_at: attemptAt } };
		mocks.paymentIntentsList.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 100); return { data: [pi], has_more: false }; });
		mocks.chargesList.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 100); return { data: [{ id: 'ch_budget', amount: 100, amount_refunded: 0 }] }; });
		await sweepPausedTopups(1, Date.now() + 1000);
		expect(mocks.paymentIntentsList).toHaveBeenCalledWith(expect.anything(), { timeout: 1000, maxNetworkRetries: 0 });
		expect(mocks.chargesList).toHaveBeenCalledWith(expect.anything(), { timeout: 900, maxNetworkRetries: 0 });
		expect(mocks.refundsCreate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timeout: 800, maxNetworkRetries: 0 }));
	} finally { vi.useRealTimers(); }
});

test('an expired recovery budget stops before the next remote call', async () => {
	await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: new Date().toISOString() });
	await pauseAutoTopupForRefund(testDb().db, 'org-1');
	const pi = { id: 'pi_expired', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1' } };
	mocks.paymentIntentsRetrieve.mockResolvedValue(pi);
	await testDb().db.update(stripeAutoTopupRecoveries).set({ paymentIntentId: pi.id });
	mocks.chargesList.mockImplementationOnce(async () => { return { data: [{ id: 'ch_expired', amount: 100, amount_refunded: 0 }] }; });
	await expect(recoverPausedTopup((await testDb().db.select().from(stripeAutoTopupRecoveries).get())!, pi, Date.now() - 1)).rejects.toThrow('deadline');
	expect(mocks.chargesList).not.toHaveBeenCalled();
	expect(mocks.refundsCreate).not.toHaveBeenCalled();
});

test.each([false, true])('a refunded lifetime top-up clears only its own idle logical attempt (newer: %s)', async (newer) => {
	const original = '2026-09-30T10:00:00.000Z';
	const current = newer ? '2026-09-30T11:00:00.000Z' : original;
	await seedOrg({ plan: 'lifetime', autoTopupState: 'idle', autoTopupLastAttemptAt: current, autoTopupAttemptAt: current, autoTopupSubmittedAt: current });
	await grantAutoTopupCredits('org-1', { id: 'pi_lifetime', status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_500', auto_topup_attempt_at: original } });
	expect(mocks.refundsCreate).toHaveBeenCalledTimes(1);
	expect(await orgRow()).toMatchObject({ autoTopupAttemptAt: newer ? current : null, autoTopupSubmittedAt: newer ? current : null });
});

test('a later legacy same-day payment cannot be refunded for an older attempt', async () => {
	const attemptAt = '2026-09-30T10:00:00.000Z';
	await seedOrg({ autoTopupState: 'in_flight', autoTopupLastAttemptAt: attemptAt });
	await pauseAutoTopupForRefund(testDb().db, 'org-1');
	mocks.paymentIntentsList.mockResolvedValueOnce({ data: [{ id: 'pi_later', created: Date.parse('2026-09-30T12:00:00.000Z') / 1000, status: 'succeeded', metadata: { type: 'auto_topup', org_id: 'org-1', auto_topup_attempt_day: '2026-09-30' } }], has_more: false });
	await sweepPausedTopups(1);
	expect(mocks.refundsCreate).not.toHaveBeenCalled();
	expect((await testDb().db.select().from(stripeAutoTopupRecoveries).get())?.paymentIntentId).toBeNull();
});
