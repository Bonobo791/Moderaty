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

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { setupTestDb, testDb } from '$lib/server/testdb';
import { creditTransactions, organizations } from '$lib/server/db/schema';
import { getCredits } from '$lib/server/billing/ledger';
import { handleAutoTopupFailure, maybeTriggerAutoTopUp, recordAutoTopupFailure, stripeErrorCode, sweepAutoTopUp } from './autotopup';

const mocks = vi.hoisted(() => ({
	paymentIntentsCreate: vi.fn(),
	paymentIntentsRetrieve: vi.fn(),
	paymentIntentsList: vi.fn(),
	pricesRetrieve: vi.fn()
}));

vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => ({
		paymentIntents: { create: mocks.paymentIntentsCreate, retrieve: mocks.paymentIntentsRetrieve, list: mocks.paymentIntentsList },
		prices: { retrieve: mocks.pricesRetrieve }
	})
}));
vi.mock('$env/dynamic/private', () => ({
	env: { STRIPE_PRICE_CREDITS_100: 'price_100', STRIPE_PRICE_CREDITS_500: 'price_500', STRIPE_PRICE_CREDITS_2000: 'price_2000' }
}));

setupTestDb(['organizations', 'credit_transactions', 'stripe_events']);

async function seedOrg(overrides: Record<string, unknown> = {}): Promise<void> {
	await testDb().db.insert(organizations).values({
		id: 'org-1',
		name: 'Org',
		creditsRemaining: 50,
		autoTopupEnabled: 1,
		autoTopupThreshold: 100,
		autoTopupState: 'idle',
		autoTopupFailures: 0,
		stripeCustomerId: 'cus_1',
		stripeDefaultPmId: 'pm_1',
		...overrides
	});
}

async function orgRow() {
	const row = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	if (!row) throw new Error('org-1 was not seeded');
	return row;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.paymentIntentsCreate.mockResolvedValue({ id: 'pi_new' });
	mocks.paymentIntentsList.mockResolvedValue({ data: [] });
	mocks.pricesRetrieve.mockResolvedValue({ id: 'price_100', unit_amount: 500, active: true, currency: 'usd', type: 'one_time' });
});

describe('maybeTriggerAutoTopUp', () => {
	test('charges the saved card off-session when below threshold, with an idempotency key', async () => {
		await seedOrg();

		const triggered = await maybeTriggerAutoTopUp('org-1');

		expect(triggered).toBe(true);
		expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
		const [params, options] = mocks.paymentIntentsCreate.mock.calls[0];
		expect(params).toMatchObject({
			amount: 500,
			currency: 'usd',
			customer: 'cus_1',
			payment_method: 'pm_1',
			off_session: true,
			confirm: true,
			metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' }
		});
		expect(options.idempotencyKey).toMatch(/^autotopup:cus_1:\d{4}-\d{2}-\d{2}:1$/);
		// The in-flight claim was placed atomically.
		expect((await orgRow()).autoTopupState).toBe('in_flight');
	});

	test('never triggers when the balance is at or above the threshold', async () => {
		await seedOrg({ creditsRemaining: 150 });
		expect(await maybeTriggerAutoTopUp('org-1')).toBe(false);
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
	test('triggers for every enabled org below its threshold, bounded by the limit', async () => {
		await seedOrg();
		await testDb().db.insert(organizations).values({
			id: 'org-2',
			name: 'Org 2',
			creditsRemaining: 10,
			autoTopupEnabled: 1,
			autoTopupThreshold: 100,
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
			autoTopupThreshold: 100,
			autoTopupState: 'idle',
			stripeCustomerId: 'cus_3',
			stripeDefaultPmId: 'pm_3'
		});

		const triggered = await sweepAutoTopUp(5);

		expect(triggered).toBe(2);
		expect(mocks.paymentIntentsCreate).toHaveBeenCalledTimes(2);
	});

	test('a failing org does not stop the sweep', async () => {
		await seedOrg();
		await testDb().db.insert(organizations).values({
			id: 'org-2',
			name: 'Org 2',
			creditsRemaining: 10,
			autoTopupEnabled: 1,
			autoTopupThreshold: 100,
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
				autoTopupThreshold: 100,
				autoTopupState: 'idle'
			});
		}
		await testDb().db.insert(organizations).values({
			id: 'org-8',
			name: 'Org 8',
			creditsRemaining: 10,
			autoTopupEnabled: 1,
			autoTopupThreshold: 100,
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
				autoTopupThreshold: 100,
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
