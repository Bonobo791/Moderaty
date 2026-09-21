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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';

import { setupTestDb, testDb } from '$lib/server/testdb';
import { db } from '$lib/server/db';
import { organizations, creditTransactions, stripeEvents, stripePendingReversals, stripeLifetimeEntitlements, stripeLifetimeSlots, stripeSubscriptionPeriods, stripeDisputeReversals, stripeCheckoutAttempts } from '$lib/server/db/schema';
import { applyLedgerDelta, getCredits } from '$lib/server/billing/ledger';
import { claimEvent, fulfillAutoTopup, fulfillCheckout, handleStripeEvent, markEventProcessed, restoreWonDispute, reverseCharge, reverseDispute } from './webhooks';

const mocks = vi.hoisted(() => ({
	sessionsRetrieve: vi.fn(),
	paymentIntentsRetrieve: vi.fn(),
	chargesRetrieve: vi.fn(),
	disputesRetrieve: vi.fn(),
	customersUpdate: vi.fn(),
	customersRetrieve: vi.fn(),
	subscriptionsRetrieve: vi.fn(),
	subscriptionsCancel: vi.fn(),
	subscriptionsUpdate: vi.fn(),
	invoicePaymentsList: vi.fn(),
	invoicesRetrieve: vi.fn(),
	paymentMethodsAttach: vi.fn(),
	refundsCreate: vi.fn()
}));

vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => ({
		checkout: { sessions: { retrieve: mocks.sessionsRetrieve } },
		paymentIntents: { retrieve: mocks.paymentIntentsRetrieve },
		charges: { retrieve: mocks.chargesRetrieve },
		disputes: { retrieve: mocks.disputesRetrieve },
		customers: { update: mocks.customersUpdate, retrieve: mocks.customersRetrieve },
		subscriptions: { retrieve: mocks.subscriptionsRetrieve, cancel: mocks.subscriptionsCancel, update: mocks.subscriptionsUpdate },
		invoicePayments: { list: mocks.invoicePaymentsList },
		invoices: { retrieve: mocks.invoicesRetrieve },
		paymentMethods: { attach: mocks.paymentMethodsAttach },
		refunds: { create: mocks.refundsCreate }
	})
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

// claimLifetimeSlot stays a vi.fn delegate so one test can stage the
// concurrent-loser throw — every other call runs the real implementation.
vi.mock('$lib/server/billing/entitlements', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/billing/entitlements')>();
	return { ...mod, claimLifetimeSlot: vi.fn(mod.claimLifetimeSlot) };
});

import { claimLifetimeSlot } from '$lib/server/billing/entitlements';

setupTestDb(['organizations', 'credit_transactions', 'stripe_events', 'stripe_pending_reversals', 'stripe_lifetime_entitlements', 'stripe_subscription_periods', 'stripe_lifetime_slots', 'stripe_dispute_reversals', 'stripe_checkout_attempts']);

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'cs_123',
		mode: 'payment',
		status: 'complete',
		payment_status: 'paid',
		metadata: { org_id: 'org-1', bundle: 'credits_500' },
		customer: 'cus_1',
		payment_intent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_1' },
		...overrides
	};
}

function event(type: string, id: string, object: Record<string, unknown>, created?: number): { id: string; type: string; created?: number; data: { object: unknown } } {
	return { id, type, ...(created === undefined ? {} : { created }), data: { object: { id, object: 'test', ...object } } };
}

beforeEach(() => {
	vi.clearAllMocks();
	// Stripe's real refunds.create resolves a Refund — the status drives the
	// helper's validate-before-ACK contract.
	mocks.refundsCreate.mockResolvedValue({ id: 're_1', status: 'succeeded' });
});



describe('fenced Stripe event leases', () => {
	test('a stale worker cannot complete an event after its lease is reclaimed', async () => {
		const evt = event('checkout.session.completed', 'evt_fenced', { id: 'cs_fenced', object: 'checkout.session' });
		const firstLease = await claimEvent(evt as never);
		expect(firstLease).toEqual(expect.any(String));
		await testDb().db.update(stripeEvents).set({ processingStartedAt: new Date(0).toISOString() }).where(eq(stripeEvents.eventId, evt.id));
		const secondLease = await claimEvent(evt as never);
		expect(secondLease).toEqual(expect.any(String));
		expect(secondLease).not.toBe(firstLease);
		expect(await markEventProcessed(evt.id, firstLease as string)).toBe(false);
		expect((await testDb().db.select().from(stripeEvents).where(eq(stripeEvents.eventId, evt.id)).get())?.processedAt).toBeNull();
		expect(await markEventProcessed(evt.id, secondLease as string)).toBe(true);
	});
});

describe('paid hosted products', () => {
	test('refunds a lifetime fulfillment while a hosted subscription is live and not ending', async () => {
		// The stored status is only a cache: before refusing the grant the
		// LIVE subscription is consulted — still billing and not scheduled to
		// end means the paid session can never grant, so the money goes back
		// (a bare 'rejected' would keep $49 for nothing).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lifetime', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		mocks.subscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active', cancel_at_period_end: false, cancel_at: null });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await fulfillCheckout('cs_lifetime')).toBe('refunded');
		} finally {
			errorSpy.mockRestore();
		}
		expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_1', metadata: { reason: 'ungrantable', org_id: 'org-1', checkout_session_id: 'cs_lifetime' } }, { idempotencyKey: 'refund:ungrantable:cs_lifetime' });
		expect(await testDb().db.select().from(stripeLifetimeEntitlements)).toHaveLength(0);
	});

	test('a lifetime checkout consults the LIVE subscription even when the cached status is non-active', async () => {
		// The stored status is only a cache: a missed subscription.deleted
		// webhook (or a portal resume that never delivered) can leave it
		// 'canceled' while Stripe still has the subscription live and billing.
		// Gating the live check on the cache would grant lifetime while the
		// customer keeps paying monthly (codeant P1) — Stripe decides, always.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'canceled' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lt_stale', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		mocks.subscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active', cancel_at_period_end: false, cancel_at: null });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await fulfillCheckout('cs_lt_stale')).toBe('refunded');
		} finally {
			errorSpy.mockRestore();
		}
		expect(mocks.subscriptionsRetrieve).toHaveBeenCalled();
		expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_1', metadata: { reason: 'ungrantable', org_id: 'org-1', checkout_session_id: 'cs_lt_stale' } }, { idempotencyKey: 'refund:ungrantable:cs_lt_stale' });
		expect(await testDb().db.select().from(stripeLifetimeEntitlements)).toHaveLength(0);
	});

	test('a lifetime checkout grants when the stored subscription is actually dead at Stripe', async () => {
		// The other side of the live check: a stale cache saying 'active' for
		// a sub Stripe knows is canceled must NOT block the upgrade — the
		// record is wrong, the live lookup is the truth.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lt_dead', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		mocks.subscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', status: 'canceled' });
		expect(await fulfillCheckout('cs_lt_dead')).toBe('granted');
		expect(await testDb().db.select().from(stripeLifetimeEntitlements)).toHaveLength(1);
	});

	test('a concurrent hosted fulfillment that loses the subscription claim tears its own sub down', async () => {
		// Two paid subscription checkouts for the same org can interleave
		// read→write: both observe no stored subscription, and an unconditional
		// UPDATE lets the second overwrite the first winner — orphaning a live,
		// billing subscription the org row no longer names (codeant P1). The
		// claim is conditional instead: the loser sees the foreign winner, and
		// cancels + refunds the subscription ITS session just minted.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		const client = testDb().client;
		const originalExecute = client.execute.bind(client);
		let injected = false;
		client.execute = (async (stmt: unknown) => {
			const sqlText = String((stmt as { sql?: string }).sql ?? stmt);
			if (!injected && /update\s+"organizations"/i.test(sqlText) && /stripe_subscription_id/i.test(sqlText)) {
				injected = true;
				// The concurrent winner commits between the loser's read and write.
				await testDb().db.update(organizations).set({ stripeSubscriptionId: 'sub_winner' }).where(eq(organizations.id, 'org-1'));
			}
			return originalExecute(stmt as never);
		}) as never;
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_loser', mode: 'subscription', subscription: 'sub_loser', metadata: { org_id: 'org-1', product: 'hosted' }, payment_intent: null }));
		mocks.subscriptionsRetrieve.mockResolvedValue({ id: 'sub_loser', status: 'active', default_payment_method: null });
		mocks.subscriptionsCancel.mockResolvedValue({ id: 'sub_loser', status: 'canceled', latest_invoice: 'in_loser' });
		mocks.invoicePaymentsList.mockResolvedValue({ data: [{ invoice: 'in_loser', payment: { payment_intent: 'pi_loser', charge: 'ch_loser' } }] });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await fulfillCheckout('cs_loser')).toBe('refunded');
		} finally {
			client.execute = originalExecute;
			errorSpy.mockRestore();
		}
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionId).toBe('sub_winner');
		expect(mocks.subscriptionsCancel).toHaveBeenCalledWith('sub_loser');
		expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_loser', metadata: { reason: 'ungrantable', org_id: 'org-1', checkout_session_id: 'cs_loser' } }, { idempotencyKey: 'refund:ungrantable:subscription:sub_loser' });
	});

	test('a lifetime checkout grants while the hosted subscription is scheduled to end', async () => {
		// The cancel-pending window is the supported upgrade path: the stored
		// flag says the sub is ending and the LIVE check confirms Stripe still
		// has it scheduled (cancel_at), so lifetime claims a slot — the hosted
		// allowance simply runs out at period end.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active', stripeSubscriptionCancelAtPeriodEnd: 1 });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lt_pending', metadata: { org_id: 'org-1', product: 'lifetime' } }));
		mocks.subscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active', cancel_at_period_end: false, cancel_at: 1_802_678_400 });
		expect(await fulfillCheckout('cs_lt_pending')).toBe('granted');
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.plan).toBe('lifetime');
		expect(await testDb().db.select().from(stripeLifetimeEntitlements)).toHaveLength(1);
	});

	test('a lifetime checkout refunds when the subscription was resumed mid-checkout', async () => {
		// The org's row still says cancel-pending, but Stripe shows the
		// subscription resumed (no cancel_at, no cancel_at_period_end): the
		// grant would overlap hosted access, so the payment is ungrantable.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active', stripeSubscriptionCancelAtPeriodEnd: 1 });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lt_resumed', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		mocks.subscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active', cancel_at_period_end: false, cancel_at: null });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await fulfillCheckout('cs_lt_resumed')).toBe('refunded');
		} finally {
			errorSpy.mockRestore();
		}
		expect(mocks.refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_1' }), expect.objectContaining({ idempotencyKey: expect.stringContaining('cs_lt_resumed') }));
		expect(await testDb().db.select().from(stripeLifetimeEntitlements)).toHaveLength(0);
	});

	test('rejects a hosted fulfillment while lifetime access is active', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1', activeEntitlementId: 1 }).where(eq(stripeLifetimeSlots.slot, 1));
		await testDb().db.insert(stripeLifetimeEntitlements).values({ id: 1, orgId: 'org-1', slot: 1, checkoutSessionId: 'cs_old' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_hosted', mode: 'subscription', subscription: 'sub_1', metadata: { org_id: 'org-1', product: 'hosted' }, payment_intent: null }));
		expect(await fulfillCheckout('cs_hosted')).toBe('rejected');
	});

	test('checkout completion records the subscription but does not grant monthly allowance', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ mode: 'subscription', subscription: 'sub_1', metadata: { org_id: 'org-1', product: 'hosted' }, payment_intent: null }));
		expect(await fulfillCheckout('cs_hosted')).toBe('granted');
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionId).toBe('sub_1');
		expect(org?.plan).toBe('free');
		expect(await testDb().db.select().from(stripeSubscriptionPeriods)).toHaveLength(0);
	});

	test('lifetime completion claims one slot and is replay-safe', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		expect((await testDb().db.select().from(stripeLifetimeEntitlements)).length).toBe(0);
		mocks.sessionsRetrieve.mockResolvedValue(session({ metadata: { org_id: 'org-1', product: 'lifetime' } }));
		expect(await fulfillCheckout('cs_lifetime')).toBe('granted');
		expect(await fulfillCheckout('cs_lifetime')).toBe('already');
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.plan).toBe('lifetime');
		expect(await testDb().db.select().from(stripeLifetimeEntitlements)).toHaveLength(1);
	});

	test('logs a paid lifetime checkout that cannot claim a slot', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.insert(stripePendingReversals).values({ chargeId: 'ch_1', reason: 'refund' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_sold', metadata: { org_id: 'org-1', product: 'lifetime' } }));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await fulfillCheckout('cs_sold')).toBe('rejected');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('PAID but claimed no slot'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a failed refund propagates so Stripe retries the delivery', async () => {
		// ACKing after a transient refund failure would leave the customer
		// charged until a human reads the log — rethrow so the redelivery
		// retries the refund under the same idempotency key (review).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lifetime', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		mocks.refundsCreate.mockRejectedValue(new Error('rate limited'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await expect(fulfillCheckout('cs_lifetime')).rejects.toThrow('rate limited');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MANUAL REFUND REQUIRED'));
		} finally {
			// clearAllMocks does not reset implementations — restore the
			// resolved default or the rejection leaks into later tests.
			mocks.refundsCreate.mockReset();
			mocks.refundsCreate.mockResolvedValue({ id: 're_1', status: 'succeeded' });
			errorSpy.mockRestore();
		}
	});

	test('a paid lifetime checkout that finds no slot auto-refunds and stays rejected', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		// Occupy every slot so claimLifetimeSlot throws sold-out (MOD-38).
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lifetime', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		expect(await fulfillCheckout('cs_lifetime')).toBe('refunded');
		expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_1', metadata: { reason: 'ungrantable', org_id: 'org-1', checkout_session_id: 'cs_lifetime' } }, { idempotencyKey: 'refund:ungrantable:cs_lifetime' });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.plan).not.toBe('lifetime');
		expect(await testDb().db.select().from(stripeLifetimeEntitlements)).toHaveLength(0);
	});

	test('a slotless checkout whose charge is already refunded is not refunded twice', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: { id: 'ch_1', refunded: true } } }));
		expect(await fulfillCheckout('cs_lifetime')).toBe('refunded');
		expect(mocks.refundsCreate).not.toHaveBeenCalled();
	});

	test('a credit purchase granted before the upgrade replays as already — never refunds the completed purchase', async () => {
		// The grant committed while the org was metered; a redelivery arriving
		// after the upgrade must no-op on the ledger idempotency anchor BEFORE
		// the unmetered-plan guard runs — refunding it would hand the customer
		// their granted credits AND their money back (codex P1).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_1', metadata: { org_id: 'org-1', bundle: 'credits_500' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		expect(await fulfillCheckout('cs_1')).toBe('granted');
		await testDb().db.update(organizations).set({ plan: 'lifetime' }).where(eq(organizations.id, 'org-1'));
		expect(await fulfillCheckout('cs_1')).toBe('already');
		expect(mocks.refundsCreate).not.toHaveBeenCalled();
	});

	test('a refund that resolves failed propagates — the customer is still charged', async () => {
		// refunds.create can RESOLVE with a non-succeeded refund: logging
		// success and ACKing would leave the customer charged with no retry
		// (codex P1). A failed/canceled refund is loud and retryable; a pending
		// one is genuinely in flight and accepted.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lifetime', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		mocks.refundsCreate.mockResolvedValue({ id: 're_1', status: 'failed' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			await expect(fulfillCheckout('cs_lifetime')).rejects.toThrow(/MANUAL REFUND REQUIRED/);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MANUAL REFUND REQUIRED'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a pending refund is accepted — the money is genuinely in flight', async () => {
		// Retrying a pending refund under the same idempotency key returns the
		// same pending object forever — treating it as a failure would retry a
		// storm against a refund Stripe is already processing (codex P1).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lifetime', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		mocks.refundsCreate.mockResolvedValue({ id: 're_1', status: 'pending' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await fulfillCheckout('cs_lifetime')).toBe('refunded');
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a paid ungrantable checkout with no payment intent throws — never claims a refund', async () => {
		// A paid session missing its payment intent is a malformed Stripe
		// response (I2): ACKing 'refunded' would tell the buyer money is
		// coming back when none was requested. Throw so the delivery retries
		// and the MANUAL REFUND REQUIRED line keeps firing (codex P1).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lifetime', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: null }));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			await expect(fulfillCheckout('cs_lifetime')).rejects.toThrow(/no payment intent/);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MANUAL REFUND REQUIRED'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a paid duplicate lifetime checkout for an org that already has lifetime auto-refunds', async () => {
		// Same class as sold-out: the checkout is paid but can grant nothing.
		// Covers the sequential duplicate AND the concurrent race whose loser
		// dies on the unique active-org index — the recovery re-read sees the
		// winner's committed row either way.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'lifetime' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1', activeEntitlementId: 1 }).where(eq(stripeLifetimeSlots.slot, 1));
		await testDb().db.insert(stripeLifetimeEntitlements).values({ id: 1, orgId: 'org-1', slot: 1, checkoutSessionId: 'cs_first' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_dup', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_2', latest_charge: 'ch_2' } }));
		expect(await fulfillCheckout('cs_dup')).toBe('refunded');
		expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_2', metadata: { reason: 'ungrantable', org_id: 'org-1', checkout_session_id: 'cs_dup' } }, { idempotencyKey: 'refund:ungrantable:cs_dup' });
		expect(await testDb().db.select().from(stripeLifetimeEntitlements)).toHaveLength(1);
	});

	test('a same-session concurrent fulfillment sees its own claim and returns already — never refunds the winner', async () => {
		// The success redirect and the webhook can fulfill the SAME session
		// concurrently: the loser's recovery re-read observes the winner's
		// active entitlement and must recognize it belongs to THIS session —
		// refunding it would hand the org lifetime access for free (codex P1).
		// The by-session SELECT is forced to miss, replaying the read window.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'lifetime' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1', activeEntitlementId: 1 }).where(eq(stripeLifetimeSlots.slot, 1));
		await testDb().db.insert(stripeLifetimeEntitlements).values({ id: 1, orgId: 'org-1', slot: 1, checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_1', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		const client = testDb().client;
		const originalExecute = client.execute.bind(client);
		client.execute = (async (stmt: unknown) => {
			const sqlText = String((stmt as { sql?: string }).sql ?? stmt);
			if (/from "stripe_lifetime_entitlements"/i.test(sqlText) && /where[\s\S]*checkout_session_id/i.test(sqlText)) {
				return { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: undefined };
			}
			return originalExecute(stmt as never);
		}) as never;
		try {
			expect(await fulfillCheckout('cs_1')).toBe('already');
		} finally {
			client.execute = originalExecute;
		}
		expect(mocks.refundsCreate).not.toHaveBeenCalled();
	});

	test('a same-session claim that loses on the unique index sees its own winner — never refunds it', async () => {
		// Deeper window: the reads before the claim all miss (the winner has
		// not committed), the claim's insert dies on the unique active-org
		// index, and the recovery re-read observes the winner — a same-session
		// winner ACKs as 'already', never a refund (codex P1).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_1', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		// The winner commits inside the claim (the concurrent winner's tx) —
		// the loser's recovery re-read then observes it.
		vi.mocked(claimLifetimeSlot).mockImplementationOnce(async () => {
			await testDb().db.insert(stripeLifetimeEntitlements).values({ orgId: 'org-1', slot: 1, checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
			throw new Error('UNIQUE constraint failed: stripe_lifetime_entitlements_active_org_idx');
		});

		expect(await fulfillCheckout('cs_1')).toBe('already');
		expect(mocks.refundsCreate).not.toHaveBeenCalled();
	});

	test('a concurrent same-session delivery never refunds the winning entitlement', async () => {
		// The success-page load and the webhook can fulfill the same session
		// concurrently: the loser's by-session read can return a pre-commit
		// snapshot and then observe the winner's active org entitlement — it
		// must return 'already', never refund the PaymentIntent that paid for
		// that entitlement (refunding it would hand the org lifetime for free).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		const client = testDb().client;
		const originalExecute = client.execute.bind(client);
		let interleaved = false;
		client.execute = (async (stmt: unknown) => {
			const sqlText = String((stmt as { sql?: string }).sql ?? stmt);
			if (!interleaved && /select .*from "stripe_lifetime_entitlements"/i.test(sqlText) && sqlText.includes('checkout_session_id')) {
				interleaved = true;
				await testDb().db.insert(stripeLifetimeEntitlements).values({ id: 1, orgId: 'org-1', slot: 1, checkoutSessionId: 'cs_1' });
				await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1', activeEntitlementId: 1 }).where(eq(stripeLifetimeSlots.slot, 1));
				return { rows: [], rowsAffected: 0, columns: [], columnTypes: [] };
			}
			return originalExecute(stmt as never);
		}) as never;
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_1', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		try {
			expect(await fulfillCheckout('cs_1')).toBe('already');
			expect(mocks.refundsCreate).not.toHaveBeenCalled();
		} finally {
			client.execute = originalExecute;
		}
	});

	test('a winner landing after the org-scoped read is never refunded by the losing delivery', async () => {
		// Deeper interleave of the same race: both pre-claim reads return a
		// pre-commit snapshot, and this session's own entitlement only becomes
		// visible at claim time — the loser must report a success verdict and
		// never refund the PaymentIntent behind the winning grant (codex P1).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		const client = testDb().client;
		const originalExecute = client.execute.bind(client);
		let fakesLeft = 2;
		client.execute = (async (stmt: unknown) => {
			const sqlText = String((stmt as { sql?: string }).sql ?? stmt);
			if (fakesLeft > 0 && /select .*from "stripe_lifetime_entitlements"/i.test(sqlText)) {
				fakesLeft -= 1;
				if (fakesLeft === 0) {
					await testDb().db.insert(stripeLifetimeEntitlements).values({ id: 1, orgId: 'org-1', slot: 1, checkoutSessionId: 'cs_1' });
					await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1', activeEntitlementId: 1 }).where(eq(stripeLifetimeSlots.slot, 1));
				}
				return { rows: [], rowsAffected: 0, columns: [], columnTypes: [] };
			}
			return originalExecute(stmt as never);
		}) as never;
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_1', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		try {
			expect(['granted', 'already']).toContain(await fulfillCheckout('cs_1'));
			expect(mocks.refundsCreate).not.toHaveBeenCalled();
		} finally {
			client.execute = originalExecute;
		}
	});

	test('a credit checkout fulfilled after the org went lifetime refunds instead of granting', async () => {
		// assertCreditsPurchasable guards checkout CREATION; the grant itself
		// must stay gated atomically or an in-flight checkout grants credits a
		// lifetime org can never use (review: TOCTOU).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'lifetime', creditsRemaining: 100 });
		mocks.sessionsRetrieve.mockResolvedValue(session());
		expect(await fulfillCheckout('cs_123')).toBe('refunded');
		expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_1', metadata: { reason: 'ungrantable', org_id: 'org-1', checkout_session_id: 'cs_123' } }, { idempotencyKey: 'refund:ungrantable:cs_123' });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.creditsRemaining).toBe(100);
	});
});


describe('subscription lifecycle webhooks', () => {

	test('invoice.paid accepts the current parent subscription payload', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		const invoice = { parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } }, customer: 'cus_1', payment_intent: 'pi_1', lines: { data: [{ subscription: 'sub_1', period: { start: 1_800_000_000, end: 1_802_678_400 } }] } };
		expect(await handleStripeEvent(event('invoice.paid', 'in_current', invoice) as never)).toBe(true);
		expect(await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in_current'))).toHaveLength(1);
	});

	test('invoice.paid selects the matching non-proration subscription line and current payment reference', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		const invoice = {
			subscription: 'sub_1',
			customer: 'cus_1',
			payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_current' } }] },
			lines: {
				data: [
					{ subscription: 'sub_1', proration: true, period: { start: 1_700_000_000, end: 1_700_086_400 } },
					{ subscription: 'sub_1', proration: false, period: { start: 1_800_000_000, end: 1_802_678_400 } }
				]
			}
		};
		expect(await handleStripeEvent(event('invoice.paid', 'in_current_payment', invoice) as never)).toBe(true);
		const period = await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in_current_payment')).get();
		expect(period).toMatchObject({ paymentIntentId: 'pi_current', periodStart: new Date(1_800_000_000 * 1000).toISOString(), periodEnd: new Date(1_802_678_400 * 1000).toISOString() });
	});

	test('invoice.paid rejects when no line belongs to the invoice subscription', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		const invoice = {
			subscription: 'sub_1',
			customer: 'cus_1',
			lines: { data: [{ subscription: 'sub_other', period: { start: 1_800_000_000, end: 1_802_678_400 } }] }
		};
		await expect(handleStripeEvent(event('invoice.paid', 'in_missing_line', invoice) as never)).rejects.toThrow('no matching non-proration subscription line');
	});

	test('invoice.paid rejects a malformed current payments payload instead of using a legacy fallback', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		const invoice = {
			subscription: 'sub_1',
			customer: 'cus_1',
			payments: 'not-a-payments-list',
			payment_intent: 'pi_legacy',
			lines: { data: [{ subscription: 'sub_1', period: { start: 1_800_000_000, end: 1_802_678_400 } }] }
		};
		await expect(handleStripeEvent(event('invoice.paid', 'in_malformed_payments', invoice) as never)).rejects.toThrow('malformed object');
	});

	test('invoice.payment_failed falls back to the invoice period before a period is stored', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		const invoice = {
			subscription: 'sub_1',
			customer: 'cus_1',
			lines: { data: [{ subscription: 'sub_1', proration: false, period: { start: 1_800_000_000, end: 1_802_678_400 } }] }
		};
		expect(await handleStripeEvent(event('invoice.payment_failed', 'in_payment_failed', invoice) as never)).toBe(true);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org).toMatchObject({ stripeSubscriptionStatus: 'past_due', stripeSubscriptionPeriodStart: new Date(1_800_000_000 * 1000).toISOString(), stripeSubscriptionPeriodEnd: new Date(1_802_678_400 * 1000).toISOString() });
	});

	test('ignores an invoice for a superseded subscription — and tears the duplicate down', async () => {
		// The tracked subscription is LIVE at Stripe, so the invoice's
		// subscription is an untracked duplicate: its paid period never grants
		// and the duplicate is canceled + refunded at Stripe (one live
		// subscription per org — codex/grilling session 2026-09-19).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_current', stripeSubscriptionStatus: 'active' });
		mocks.subscriptionsRetrieve.mockImplementation((id: string) => Promise.resolve(id === 'sub_current' ? { id, status: 'active' } : { id, status: 'active' }));
		mocks.subscriptionsCancel.mockResolvedValue({ id: 'sub_old', status: 'canceled', latest_invoice: 'in_stale' });
		mocks.invoicePaymentsList.mockResolvedValue({ data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_dup' } }] });
		const invoice = { id: 'in_stale', subscription: 'sub_old', customer: 'cus_1', payment_intent: 'pi_dup', lines: { data: [{ subscription: 'sub_old', period: { start: 1_800_000_000, end: 1_802_678_400 } }] } };
		expect(await handleStripeEvent(event('invoice.paid', 'evt_stale_invoice', invoice) as never)).toBe(true);
		expect(await testDb().db.select().from(stripeSubscriptionPeriods)).toHaveLength(0);
		expect(mocks.subscriptionsCancel).toHaveBeenCalledWith('sub_old');
		expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_dup', metadata: expect.objectContaining({ reason: 'ungrantable', org_id: 'org-1' }) }, { idempotencyKey: 'refund:ungrantable:subscription:sub_old' });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionId).toBe('sub_current');
	});

	test('an invoice for a resubscribe grants when the tracked subscription is dead at Stripe', async () => {
		// Stored pointer can name a subscription Stripe has already canceled
		// (stored status is only a cache — webhooks can lag or fail). The new
		// subscription's invoice.paid arriving before checkout.session.completed
		// must still grant its period, not be skipped as "superseded".
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_old', stripeSubscriptionStatus: null });
		mocks.subscriptionsRetrieve.mockImplementation((id: string) => Promise.resolve({ id, status: 'canceled' }));
		const invoice = { id: 'in_resub', subscription: 'sub_new', customer: 'cus_1', payment_intent: 'pi_new', lines: { data: [{ subscription: 'sub_new', period: { start: 1_800_000_000, end: 1_802_678_400 } }] } };
		expect(await handleStripeEvent(event('invoice.paid', 'evt_resub_invoice', invoice) as never)).toBe(true);
		expect(await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in_resub'))).toHaveLength(1);
		expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
	});

	test('invoice.paid reads payment references from the invoicePayments API when the payload omits them', async () => {
		// api 2026-07-29.dahlia payloads can ship an invoice with NO payments,
		// payment_intent or charge fields at all (observed on a live sandbox
		// delivery) — the reference must be fetched or the period never grants.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		mocks.invoicePaymentsList.mockResolvedValue({ data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_fetched' } }] });
		const invoice = {
			parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
			customer: 'cus_1',
			lines: { data: [{ parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_1', proration: false } }, period: { start: 1_800_000_000, end: 1_802_678_400 } }] }
		};
		expect(await handleStripeEvent(event('invoice.paid', 'in_api_refs', invoice) as never)).toBe(true);
		expect(mocks.invoicePaymentsList).toHaveBeenCalledWith({ invoice: 'in_api_refs', status: 'paid' });
		const period = await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in_api_refs')).get();
		expect(period).toMatchObject({ paymentIntentId: 'pi_fetched' });
	});

	test('invoice.paid still throws when no usable payment reference exists anywhere', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		mocks.invoicePaymentsList.mockResolvedValue({ data: [{ payment: { type: 'payment_record', payment_record: 'pr_1' } }] });
		const invoice = {
			parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
			customer: 'cus_1',
			lines: { data: [{ subscription: 'sub_1', period: { start: 1_800_000_000, end: 1_802_678_400 } }] }
		};
		await expect(handleStripeEvent(event('invoice.paid', 'in_no_refs', invoice) as never)).rejects.toThrow('no usable payment reference');
		expect(await testDb().db.select().from(stripeSubscriptionPeriods)).toHaveLength(0);
	});

	test('a subscription event for a different subscription while one is live tears the duplicate down', async () => {
		// Stripe does not order deliveries: customer.subscription.created for a
		// duplicate can arrive BEFORE checkout.session.completed. The tracked
		// subscription must win either way — the duplicate is canceled +
		// refunded and its snapshot never displaces the org's pointer.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_tracked', stripeSubscriptionStatus: 'active' });
		mocks.subscriptionsRetrieve.mockImplementation((id: string) => Promise.resolve({ id, status: 'active' }));
		mocks.subscriptionsCancel.mockResolvedValue({ id: 'sub_dup', status: 'canceled', latest_invoice: 'in_dup' });
		mocks.invoicePaymentsList.mockResolvedValue({ data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_dup' } }] });
		const subscription = { id: 'sub_dup', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false };
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await handleStripeEvent(event('customer.subscription.created', 'evt_dup_sub', subscription) as never)).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
		expect(mocks.subscriptionsCancel).toHaveBeenCalledWith('sub_dup');
		expect(mocks.refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_dup' }), { idempotencyKey: 'refund:ungrantable:subscription:sub_dup' });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionId).toBe('sub_tracked');
		expect(org?.stripeSubscriptionStatus).toBe('active');
	});

	test('a subscription event re-points the org once the tracked subscription is dead', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_old', stripeSubscriptionStatus: 'canceled' });
		mocks.subscriptionsRetrieve.mockImplementation((id: string) => Promise.resolve({ id, status: 'canceled' }));
		const subscription = { id: 'sub_new', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false };
		expect(await handleStripeEvent(event('customer.subscription.created', 'evt_resub', subscription) as never)).toBe(true);
		expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionId).toBe('sub_new');
		expect(org?.stripeSubscriptionStatus).toBe('active');
	});

	test('subscription events read billing periods from subscription items', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false, items: { data: [{ current_period_start: 1_800_000_000, current_period_end: 1_802_678_400 }] } };
		expect(await handleStripeEvent(event('customer.subscription.updated', 'sub_current', subscription) as never)).toBe(true);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionPeriodStart).toBe(new Date(1_800_000_000 * 1000).toISOString());
	});
	test('invoice.paid creates one period allowance and replay does not create another', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		const invoice = { subscription: 'sub_1', customer: 'cus_1', payment_intent: 'pi_1', lines: { data: [{ subscription: 'sub_1', period: { start: 1_800_000_000, end: 1_802_678_400 } }] } };
		const paid = event('invoice.paid', 'in_1', invoice);
		expect(await handleStripeEvent(paid as never)).toBe(true);
		expect(await handleStripeEvent(paid as never)).toBe(true);
		expect(await testDb().db.select().from(stripeSubscriptionPeriods)).toHaveLength(1);
	});

	test('subscription updates are versioned so an older cancellation cannot downgrade active state', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		const newer = { ...event('customer.subscription.updated', 'evt_new', { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false }), created: 200 };
		const older = { ...event('customer.subscription.deleted', 'evt_old', { id: 'sub_1', customer: 'cus_1', status: 'canceled', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false }), created: 100 };
		expect(await handleStripeEvent(newer as never)).toBe(true);
		expect(await handleStripeEvent(older as never)).toBe(true);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.plan).toBe('hosted');
		expect(org?.stripeSubscriptionStatus).toBe('active');
	});

	test('subscription events sync the subscription default card as the saved top-up card', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', autoTopupEnabled: 1, autoTopupState: 'idle' });
		// Subscription Checkout stores the paid card on subscription.default_payment_method,
		// not customer.invoice_settings — this event is the only delivery of it.
		const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false, default_payment_method: 'pm_sub_1' };
		expect(await handleStripeEvent(event('customer.subscription.updated', 'evt_pm_sync', subscription, 300) as never)).toBe(true);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeDefaultPmId).toBe('pm_sub_1');
		// The consent evidence covered the previous card, so a card change under
		// enabled auto top-up pauses it pending fresh consent (savePaymentMethod rule).
		expect(org?.autoTopupEnabled).toBe(0);
		expect(org?.autoTopupState).toBe('disabled');
	});

	test('subscription card sync leaves auto top-up alone when the card is unchanged', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeDefaultPmId: 'pm_sub_1', autoTopupEnabled: 1, autoTopupState: 'idle' });
		const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false, default_payment_method: { id: 'pm_sub_1' } };
		expect(await handleStripeEvent(event('customer.subscription.updated', 'evt_pm_same', subscription, 300) as never)).toBe(true);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeDefaultPmId).toBe('pm_sub_1');
		expect(org?.autoTopupEnabled).toBe(1);
		expect(org?.autoTopupState).toBe('idle');
	});

	test('a subscription without a default card does not clear the saved pointer', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeDefaultPmId: 'pm_keep' });
		// null means the subscription falls back to the customer-level default — the
		// card still exists; only payment_method.detached/customer.updated may clear it.
		const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false, default_payment_method: null };
		expect(await handleStripeEvent(event('customer.subscription.updated', 'evt_pm_null', subscription, 300) as never)).toBe(true);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeDefaultPmId).toBe('pm_keep');
	});

	test('a stale subscription event cannot regress the saved card', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		const base = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false };
		expect(await handleStripeEvent(event('customer.subscription.updated', 'evt_pm_new', { ...base, default_payment_method: 'pm_new' }, 300) as never)).toBe(true);
		expect(await handleStripeEvent(event('customer.subscription.updated', 'evt_pm_old', { ...base, default_payment_method: 'pm_old' }, 100) as never)).toBe(true);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeDefaultPmId).toBe('pm_new');
	});

	test('a malformed subscription default_payment_method fails loudly', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false, default_payment_method: { id: 123 } };
		await expect(handleStripeEvent(event('customer.subscription.updated', 'evt_pm_bad', subscription, 300) as never)).rejects.toThrow('malformed default_payment_method');
	});

	test('a portal cancellation scheduled via cancel_at is recorded as pending', async () => {
		// The Stripe customer portal schedules end-of-period cancellation via
		// the cancel_at TIMESTAMP while cancel_at_period_end stays false —
		// reading only the flag records a canceled sub as "not canceling" and
		// the pending cancel stays invisible to the org (production repro).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false, cancel_at: 1_802_678_400, canceled_at: 1_800_100_000 };
		expect(await handleStripeEvent(event('customer.subscription.updated', 'evt_cancel_at', subscription, 300) as never)).toBe(true);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionCancelAtPeriodEnd).toBe(1);
		expect(org?.plan).toBe('hosted');
	});

	test('a malformed cancel_at timestamp fails loudly', async () => {
		// I2: a present-but-garbage cancel_at is a failed API call — throwing
		// keeps the delivery un-ACKed instead of persisting "not canceling".
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false, cancel_at: 'soon' };
		await expect(handleStripeEvent(event('customer.subscription.updated', 'evt_bad_cancel_at', subscription, 300) as never)).rejects.toThrow('cancel_at');
	});

	test('resuming a scheduled cancellation clears the pending flag', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active', stripeSubscriptionCancelAtPeriodEnd: 1 });
		const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false, cancel_at: null, canceled_at: null };
		expect(await handleStripeEvent(event('customer.subscription.updated', 'evt_resumed', subscription, 300) as never)).toBe(true);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionCancelAtPeriodEnd).toBe(0);
		expect(mocks.subscriptionsUpdate).not.toHaveBeenCalled();
	});

	test('a subscription resumed on a lifetime org is re-canceled at period end', async () => {
		// Lifetime can be bought while a hosted sub is merely scheduled to
		// end; a portal resume after that purchase would keep billing $5/mo
		// for an entitlement the lifetime plan already covers — the handler
		// re-schedules its cancellation (period end, per the Terms' cancel
		// rule) and screams, instead of silently double-charging forever.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'lifetime', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1', activeEntitlementId: 1 }).where(eq(stripeLifetimeSlots.slot, 1));
		await testDb().db.insert(stripeLifetimeEntitlements).values({ id: 1, orgId: 'org-1', slot: 1, checkoutSessionId: 'cs_lt' });
		const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false, cancel_at: null, canceled_at: null };
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await handleStripeEvent(event('customer.subscription.updated', 'evt_resume_lt', subscription, 300) as never)).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
		expect(mocks.subscriptionsUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.plan).toBe('lifetime');
	});

	test('a subscription still scheduled to end on a lifetime org is left alone', async () => {
		// The normal upgrade path: sub is ending at period end while lifetime
		// is active — nothing to re-cancel, no Stripe write at all.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'lifetime', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1', activeEntitlementId: 1 }).where(eq(stripeLifetimeSlots.slot, 1));
		await testDb().db.insert(stripeLifetimeEntitlements).values({ id: 1, orgId: 'org-1', slot: 1, checkoutSessionId: 'cs_lt' });
		const subscription = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false, cancel_at: 1_802_678_400 };
		expect(await handleStripeEvent(event('customer.subscription.updated', 'evt_lt_ending', subscription, 300) as never)).toBe(true);
		expect(mocks.subscriptionsUpdate).not.toHaveBeenCalled();
		expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
	});

	test('hosted fulfillment stores the subscription card without waiting for subscription events', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ mode: 'subscription', subscription: 'sub_1', metadata: { org_id: 'org-1', product: 'hosted' }, payment_intent: null }));
		mocks.subscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', default_payment_method: 'pm_sub_1' });
		expect(await fulfillCheckout('cs_123')).toBe('granted');
		expect(mocks.subscriptionsRetrieve).toHaveBeenCalledWith('sub_1', { expand: ['default_payment_method'] });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionId).toBe('sub_1');
		expect(org?.stripeDefaultPmId).toBe('pm_sub_1');
	});

	test('a second hosted checkout while the stored subscription is LIVE cancels and refunds the duplicate', async () => {
		// The outage scenario: the stored status cache can be null or stale, so
		// the verdict comes from a LIVE retrieve of the stored subscription.
		// The new subscription is canceled (stops all future billing) and its
		// first paid invoice is refunded — the org keeps its original pointer.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_old', stripeSubscriptionStatus: null });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_dup', mode: 'subscription', subscription: 'sub_new', metadata: { org_id: 'org-1', product: 'hosted' }, payment_intent: null }));
		mocks.subscriptionsRetrieve.mockImplementation((id: string) => Promise.resolve(id === 'sub_old' ? { id, status: 'active' } : { id }));
		mocks.subscriptionsCancel.mockResolvedValue({ id: 'sub_new', status: 'canceled', latest_invoice: 'in_dup' });
		mocks.invoicePaymentsList.mockResolvedValue({ data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_dup' } }] });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await fulfillCheckout('cs_dup')).toBe('refunded');
		} finally {
			errorSpy.mockRestore();
		}
		expect(mocks.subscriptionsCancel).toHaveBeenCalledWith('sub_new');
		expect(mocks.invoicePaymentsList).toHaveBeenCalledWith({ invoice: 'in_dup', status: 'paid' });
		expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_dup', metadata: { reason: 'ungrantable', org_id: 'org-1', checkout_session_id: 'cs_dup' } }, { idempotencyKey: 'refund:ungrantable:subscription:sub_new' });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionId).toBe('sub_old');
	});

	test('a hosted checkout replaces a stored subscription that is DEAD at Stripe', async () => {
		// Resubscribe after a real cancel: the live check sees the old sub is
		// gone, so the new checkout proceeds and re-points the org.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_old', stripeSubscriptionStatus: 'canceled' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_resub', mode: 'subscription', subscription: 'sub_new', metadata: { org_id: 'org-1', product: 'hosted' }, payment_intent: null }));
		mocks.subscriptionsRetrieve.mockImplementation((id: string, opts?: unknown) =>
			Promise.resolve(id === 'sub_old' ? { id, status: 'canceled' } : { id, default_payment_method: 'pm_new' })
		);
		expect(await fulfillCheckout('cs_resub')).toBe('granted');
		expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionId).toBe('sub_new');
		expect(org?.stripeDefaultPmId).toBe('pm_new');
	});

	test('a hosted subscriber can still buy a credit bundle', async () => {
		// Subscription + top-ups coexist: an active hosted plan must never
		// block or refund a credits purchase.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active', plan: 'hosted' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_credits', metadata: { org_id: 'org-1', bundle: 'credits_500' } }));
		expect(await fulfillCheckout('cs_credits')).toBe('granted');
		expect(await getCredits('org-1')).toBe(500);
		expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
	});
	test('a won dispute restores a subscription period allowance', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
		await handleStripeEvent(event('invoice.paid', 'in_1', { id: 'in_1', subscription: 'sub_1', payment_intent: 'pi_1', charge: 'ch_1', period_start: 1798848000, period_end: 1801526400, lines: { data: [{ subscription: 'sub_1', period: { start: 1798848000, end: 1801526400 } }] } }) as never);
		mocks.disputesRetrieve.mockResolvedValueOnce({ id: 'disp_sub', charge: 'ch_1', status: 'lost' }).mockResolvedValueOnce({ id: 'disp_sub', charge: 'ch_1', status: 'won' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1', amount: 500, amount_refunded: 0 });
		await reverseDispute('disp_sub');
		expect(await restoreWonDispute('disp_sub')).toBe(true);
		expect((await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in_1')).get())?.status).toBe('paid');
	});

	test('a won dispute restores the lifetime entitlement that the dispute revoked', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lifetime', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		expect(await fulfillCheckout('cs_lifetime')).toBe('granted');
		mocks.disputesRetrieve.mockResolvedValueOnce({ id: 'disp_1', charge: 'ch_1', status: 'lost' }).mockResolvedValueOnce({ id: 'disp_1', charge: 'ch_1', status: 'won' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1', amount: 4900, amount_refunded: 0 });
		expect(await reverseDispute('disp_1')).toBe(true);
		expect(await restoreWonDispute('disp_1')).toBe(true);
		expect((await testDb().db.select().from(stripeLifetimeEntitlements).where(eq(stripeLifetimeEntitlements.checkoutSessionId, 'cs_lifetime')).get())?.status).toBe('active');
	});

	test('retries a dispute after a crash keeps a prior ledger reversal restorable', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: -500, reason: 'dispute', refType: 'dispute', refId: 'ch_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		await testDb().db.insert(stripeDisputeReversals).values({ disputeId: 'disp_retry', chargeId: 'ch_1', paymentIntentId: 'pi_1', status: 'pending', source: 'unknown' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1' });
		mocks.disputesRetrieve.mockResolvedValue({ id: 'disp_retry', charge: 'ch_1', status: 'won' });
		expect(await reverseCharge('ch_1', 'dispute', 'disp_retry')).toBe(false);
		expect((await testDb().db.select().from(stripeDisputeReversals).where(eq(stripeDisputeReversals.disputeId, 'disp_retry')).get())?.status).toBe('reversed');
		expect(await restoreWonDispute('disp_retry')).toBe(true);
		expect(await getCredits('org-1')).toBe(500);
	});

	test('two disputes on one charge cannot each restore the same credit reversal', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(testDb().db as never, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		let won = false;
		mocks.disputesRetrieve.mockImplementation(async (id: string) => ({ id, charge: 'ch_1', status: won ? 'won' : 'lost' }));
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1', amount: 5000, amount_refunded: 0 });
		await reverseDispute('disp_1');
		await reverseDispute('disp_2');
		won = true;
		await restoreWonDispute('disp_1');
		await restoreWonDispute('disp_2');
		expect(await getCredits('org-1')).toBe(500);
		expect(await testDb().db.select().from(stripeDisputeReversals)).toHaveLength(2);
	});

	test('a won dispute on an unmetered org closes the reversal without re-granting credits', async () => {
		// The org upgraded to lifetime while the dispute was open: the credit
		// restore is moot on an unmetered plan, and the unmetered-grant guard
		// would otherwise wedge the dispute webhook on a permanent throw.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'lifetime', creditsRemaining: 0 });
		await testDb().db.insert(creditTransactions).values({ orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		await testDb().db.insert(creditTransactions).values({ orgId: 'org-1', delta: -500, reason: 'dispute', refType: 'dispute', refId: 'ch_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		await testDb().db.insert(stripeDisputeReversals).values({ disputeId: 'disp_w', chargeId: 'ch_1', paymentIntentId: 'pi_1', status: 'reversed', source: 'credits' });
		mocks.disputesRetrieve.mockResolvedValue({ id: 'disp_w', charge: 'ch_1', status: 'won' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(await restoreWonDispute('disp_w')).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
		expect((await testDb().db.select().from(stripeDisputeReversals).where(eq(stripeDisputeReversals.disputeId, 'disp_w')).get())?.status).toBe('restored');
		expect(await testDb().db.select().from(creditTransactions).where(eq(creditTransactions.reason, 'adjust'))).toHaveLength(0);
	});

	test('concurrent delivery claims one inbox lease and rejects the competing worker', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		let releaseSession!: (value: Record<string, unknown>) => void;
		mocks.sessionsRetrieve.mockImplementation(() => new Promise((resolve) => { releaseSession = resolve; }));
		const evt = event('checkout.session.completed', 'evt_concurrent', { id: 'cs_concurrent', object: 'checkout.session' });
		const first = handleStripeEvent(evt as never);
		await vi.waitFor(async () => expect(await testDb().db.select().from(stripeEvents).where(eq(stripeEvents.eventId, 'evt_concurrent')).get()).toMatchObject({ processedAt: null, processingStartedAt: expect.any(String) }));
		await expect(handleStripeEvent(evt as never)).rejects.toThrow('already being processed');
		releaseSession(session({ id: 'cs_concurrent', metadata: { org_id: 'org-1', bundle: 'credits_500' } }));
		expect(await first).toBe(true);
	});

	test('a lifetime dispute releases the entitlement and frees its slot', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_lifetime', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }));
		expect(await fulfillCheckout('cs_lifetime')).toBe('granted');
		mocks.disputesRetrieve.mockResolvedValue({ id: 'disp_1', charge: 'ch_1' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1', amount: 4900, amount_refunded: 0 });
		expect(await handleStripeEvent(event('charge.dispute.created', 'disp_1', { id: 'ch_1', object: 'dispute' }) as never)).toBe(true);
		expect(await testDb().db.select().from(stripeLifetimeEntitlements)).toMatchObject([{ status: 'disputed' }]);
		expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.plan).toBe('free');
	});

});

describe('fulfillCheckout', () => {
	test('grants the bundle credits and saves the card as default', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session());

		const applied = await fulfillCheckout('cs_123');

		expect(applied).toBe('granted');
		expect(await getCredits('org-1')).toBe(500);
		// Checkout returns the payment_method as an ID string (not expanded):
		// no attach call, the default_payment_method is set directly.
		expect(mocks.paymentMethodsAttach).not.toHaveBeenCalled();
		expect(mocks.customersUpdate).toHaveBeenCalledWith('cus_1', { invoice_settings: { default_payment_method: 'pm_1' } });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeCustomerId).toBe('cus_1');
		expect(org?.stripeDefaultPmId).toBe('pm_1');
	});

	test('refuses a LATE grant when the charge was since fully refunded or disputed', async () => {
		// The success page can call fulfillCheckout for an old paid session at
		// ANY time — long after the 14-day pending-reversal sweep dropped a
		// queued reversal. Granting then would hand credits back for money that
		// already left; the charge's CURRENT state must be revalidated before
		// any late grant (codex review).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });

		// Fully refunded charge: never grant — but the verdict is 'refunded',
		// not generic 'rejected', so the success page keeps showing the
		// deliberate refunded state on every later load (codex, round 3).
		mocks.sessionsRetrieve.mockResolvedValue(
			session({
				payment_intent: { id: 'pi_1', latest_charge: { id: 'ch_1', disputed: false, amount: 50000, amount_refunded: 50000 }, payment_method: 'pm_1' }
			})
		);
		expect(await fulfillCheckout('cs_1')).toBe('refunded');
		expect(await getCredits('org-1')).toBe(0);

		// Disputed charge: reject, never grant.
		mocks.sessionsRetrieve.mockResolvedValue(
			session({
				payment_intent: { id: 'pi_1', latest_charge: { id: 'ch_1', disputed: true, amount: 50000, amount_refunded: 0 }, payment_method: 'pm_1' }
			})
		);
		expect(await fulfillCheckout('cs_1')).toBe('rejected');
		expect(await getCredits('org-1')).toBe(0);

		// A healthy charge still grants (the common case is unchanged).
		mocks.sessionsRetrieve.mockResolvedValue(
			session({
				payment_intent: { id: 'pi_1', latest_charge: { id: 'ch_1', disputed: false, amount: 50000, amount_refunded: 0 }, payment_method: 'pm_1' }
			})
		);
		expect(await fulfillCheckout('cs_1')).toBe('granted');
		expect(await getCredits('org-1')).toBe(500);
	});

	test('is idempotent: a duplicate delivery never double-grants', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session());

		expect(await fulfillCheckout('cs_123')).toBe('granted');
		expect(await fulfillCheckout('cs_123')).toBe('already');
		expect(await getCredits('org-1')).toBe(500);
	});

	test('a NEW saved payment method disables auto top-up — the old consent does not cover the new card', async () => {
		// In a team org with auto top-up already enabled, another owner can buy
		// a manual bundle with a DIFFERENT card. The new cardholder consented
		// only to the one manual Checkout payment — the next low-balance sweep
		// must not charge their card off-session on the strength of the
		// previous owner's consent (codex review).
		await testDb().db.insert(organizations).values({
			id: 'org-1',
			name: 'Org',
			autoTopupEnabled: 1,
			autoTopupState: 'idle',
			autoTopupThreshold: 100,
			stripeCustomerId: 'cus_1',
			stripeDefaultPmId: 'pm_old'
		});
		mocks.sessionsRetrieve.mockResolvedValue(
			session({ customer: 'cus_1', payment_intent: { id: 'pi_1', latest_charge: { id: 'ch_1', disputed: false, amount: 50000, amount_refunded: 0 }, payment_method: { id: 'pm_new' } } })
		);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(await fulfillCheckout('cs_1')).toBe('granted');
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeDefaultPmId).toBe('pm_new');
		expect(org?.autoTopupEnabled).toBe(0); // disabled — fresh consent required
		expect(org?.autoTopupState).toBe('disabled');
		errorSpy.mockRestore();
	});

	test('re-using the SAME saved card keeps auto top-up enabled', async () => {
		// The consent evidence covers the stored card; a purchase with that
		// same card changes nothing and must not disable anything.
		await testDb().db.insert(organizations).values({
			id: 'org-1',
			name: 'Org',
			autoTopupEnabled: 1,
			autoTopupState: 'idle',
			autoTopupThreshold: 100,
			stripeCustomerId: 'cus_1',
			stripeDefaultPmId: 'pm_1'
		});
		mocks.sessionsRetrieve.mockResolvedValue(session({ customer: 'cus_1' }));

		expect(await fulfillCheckout('cs_1')).toBe('granted');
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupEnabled).toBe(1);
		expect(org?.autoTopupState).toBe('idle');
	});

	test('never credits an unpaid session', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ payment_status: 'unpaid' }));

		expect(await fulfillCheckout('cs_123')).toBe('rejected');
		expect(await getCredits('org-1')).toBe(0);
	});

	test('fails loudly when metadata is missing — never credits the wrong org', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.sessionsRetrieve.mockResolvedValue(session({ metadata: {} }));

		expect(await fulfillCheckout('cs_123')).toBe('rejected');
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no org_id/bundle metadata'));
		errorSpy.mockRestore();
	});

	test('an unknown bundle id is a loud rejection — never a fake grant, never a retry storm', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.sessionsRetrieve.mockResolvedValue(session({ metadata: { org_id: 'org-1', bundle: 'credits_999999' } }));
		expect(await fulfillCheckout('cs_123')).toBe('rejected');
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown bundle'));
		errorSpy.mockRestore();
	});

	test('a transient card-save failure PROPAGATES so the webhook retry saves the card', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session());
		// First delivery: the grant lands, but the card save fails transiently.
		// The failure must THROW (the webhook route answers 500) so Stripe
		// redelivers — otherwise the org permanently has no top-up card
		// (codex 6141). The grant stays applied (idempotent).
		mocks.customersUpdate.mockRejectedValueOnce(new Error('network blip'));
		await expect(fulfillCheckout('cs_123')).rejects.toThrow('could not save payment method');
		expect(await getCredits('org-1')).toBe(500);
		let org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeDefaultPmId).toBeNull();
		// The retry delivery: the grant is already applied ('already') but the
		// card save MUST run — otherwise the org permanently has no top-up card.
		expect(await fulfillCheckout('cs_123')).toBe('already');
		org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeCustomerId).toBe('cus_1');
		expect(org?.stripeDefaultPmId).toBe('pm_1');
	});
});

describe('fulfillAutoTopup', () => {
	test('grants credits for a succeeded auto-topup PI and releases the claim', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', autoTopupState: 'in_flight' });
		mocks.paymentIntentsRetrieve.mockResolvedValue({
			id: 'pi_9',
			status: 'succeeded',
			latest_charge: 'ch_9',
			metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' }
		});

		expect(await fulfillAutoTopup('pi_9')).toBe(true);
		expect(await getCredits('org-1')).toBe(100);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupState).toBe('idle');
		expect(org?.autoTopupFailures).toBe(0);
	});

	test('ignores PIs that are not ours (no auto_topup metadata)', async () => {
		mocks.paymentIntentsRetrieve.mockResolvedValue({ id: 'pi_9', status: 'succeeded', metadata: {} });
		expect(await fulfillAutoTopup('pi_9')).toBe(false);
	});

	test('is idempotent: the same PI never grants twice', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.paymentIntentsRetrieve.mockResolvedValue({
			id: 'pi_9',
			status: 'succeeded',
			latest_charge: 'ch_9',
			metadata: { type: 'auto_topup', org_id: 'org-1', bundle: 'credits_100' }
		});

		expect(await fulfillAutoTopup('pi_9')).toBe(true);
		expect(await fulfillAutoTopup('pi_9')).toBe(false);
		expect(await getCredits('org-1')).toBe(100);
	});
});

describe('reverseCharge / reverseDispute', () => {
	test('a refund reverses the grant it maps to, once', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1', amount: 50000, amount_refunded: 50000 });

		expect(await reverseCharge('ch_1', 'refund')).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		expect(await reverseCharge('ch_1', 'refund')).toBe(false); // idempotent
		expect(await getCredits('org-1')).toBe(0);
	});

	test('a PARTIAL refund reverses nothing — v1 reverses only full refunds', async () => {
		// Stripe's charge.refunded fires for partial refunds too; the amounts
		// prove this one is partial, so the full grant must stay put.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1', amount: 50000, amount_refunded: 10000 });

		expect(await reverseCharge('ch_1', 'refund')).toBe(false);
		expect(await getCredits('org-1')).toBe(500);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not a full refund'));
		errorSpy.mockRestore();
	});

	test('a refund whose amounts are missing reverses nothing and logs loudly', async () => {
		// Malformed/partial-shaped charge data must never take credits away.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1' });

		expect(await reverseCharge('ch_1', 'refund')).toBe(false);
		expect(await getCredits('org-1')).toBe(500);
		errorSpy.mockRestore();
	});

	test('a dispute reverses the grant it maps to, once', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		mocks.disputesRetrieve.mockResolvedValue({ id: 'du_1', charge: 'ch_1' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1' });

		expect(await reverseDispute('du_1')).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		expect(await reverseDispute('du_1')).toBe(false);
	});

	test('a refund after a WON dispute is restored reverses the re-grant once (distinct anchors)', async () => {
		// The full lifecycle: grant → dispute.created reversal → dispute closed
		// won → restore → legitimate full refund. The refund reversal must
		// apply even though the dispute reversal row sits on the same charge —
		// distinct anchors per reason (refType 'refund' vs 'dispute') make both
		// apply exactly once, so the customer never keeps credits after the
		// money is refunded, and never loses credits twice.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		mocks.disputesRetrieve.mockResolvedValueOnce({ id: 'du_1', charge: 'ch_1', status: 'lost' }).mockResolvedValueOnce({ id: 'du_1', charge: 'ch_1', status: 'won' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1', amount: 200000, amount_refunded: 200000 });

		expect(await reverseDispute('du_1')).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		expect(await restoreWonDispute('du_1')).toBe(true);
		expect(await getCredits('org-1')).toBe(2000);
		expect(await reverseCharge('ch_1', 'refund')).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		// A duplicate refund delivery never reverses twice.
		expect(await reverseCharge('ch_1', 'refund')).toBe(false);
		expect(await getCredits('org-1')).toBe(0);
	});

	test('a dispute disables automatic top-up for the org', async () => {
		// Docs §7: on charge.dispute.created, mark the customer's auto top-up
		// disabled pending review — the sweep must never re-charge someone who
		// just disputed a charge.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', autoTopupEnabled: 1, autoTopupState: 'idle' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		mocks.disputesRetrieve.mockResolvedValue({ id: 'du_1', charge: 'ch_1' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1' });

		expect(await reverseDispute('du_1')).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupEnabled).toBe(0);
		expect(org?.autoTopupState).toBe('disabled');
	});

	test('a won dispute re-grants the reversed credits, once', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		mocks.disputesRetrieve.mockResolvedValueOnce({ id: 'du_1', charge: 'ch_1', status: 'lost' }).mockResolvedValueOnce({ id: 'du_1', charge: 'ch_1', status: 'won' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1' });
		await reverseDispute('du_1');

		expect(await restoreWonDispute('du_1')).toBe(true);
		expect(await getCredits('org-1')).toBe(2000);
		expect(await restoreWonDispute('du_1')).toBe(false);
		expect(await getCredits('org-1')).toBe(2000);
	});

	test('a won dispute WITHOUT a prior reversal never doubles the grant', async () => {
		// The dispute.created delivery was lost; only closed(won) arrived.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		mocks.disputesRetrieve.mockResolvedValue({ id: 'du_1', charge: 'ch_1', status: 'won' });

		expect(await restoreWonDispute('du_1')).toBe(false);
		expect(await getCredits('org-1')).toBe(2000);
	});

	test('a full refund of a partially-spent grant ZEROES the balance — never a negative debt', async () => {
		// "Refunded" means the credits are gone, not a negative balance carried
		// against the next purchase: the reversal floors at zero. Disputes stay
		// unbounded on purpose — a won dispute restores the FULL grant, so the
		// true negative must be kept or the restore would over-credit.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		// 300 of the 500 were spent before the refund landed.
		await testDb().db.update(organizations).set({ creditsRemaining: 200 }).where(eq(organizations.id, 'org-1'));
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1', amount: 50000, amount_refunded: 50000 });

		expect(await reverseCharge('ch_1', 'refund')).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
	});

	test('a full refund of a subscription charge cancels the subscription at Stripe', async () => {
		// Marking the period 'refunded' kills THIS period's included comments,
		// but an uncanceled subscription stays active and the next invoice.paid
		// grants a fresh paid period — service resumes on a refunded account.
		// The subscription must be canceled so it cannot renew.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'hosted', creditsRemaining: 1000, stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		await testDb().db.insert(stripeSubscriptionPeriods).values({ orgId: 'org-1', subscriptionId: 'sub_1', invoiceId: 'in_1', paymentIntentId: 'pi_sub', chargeId: 'ch_sub', periodKey: 'p1', periodStart: new Date(Date.now() - 60_000).toISOString(), periodEnd: new Date(Date.now() + 60_000).toISOString(), includedCredits: 100, consumedCredits: 0, status: 'paid' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_sub', payment_intent: 'pi_sub', amount: 500, amount_refunded: 500 });
		mocks.subscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active' });
		mocks.subscriptionsCancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' });

		expect(await reverseCharge('ch_sub', 'refund')).toBe(true);
		expect(mocks.subscriptionsCancel).toHaveBeenCalledWith('sub_1');
		// Only the refunded purchase dies: the period's 100 included comments
		// are gone, the 1000 SEPARATELY purchased credits are untouched.
		expect(await getCredits('org-1')).toBe(1000);

		// The canceled subscription's deleted event then drops the org to free.
		const deleted = event('customer.subscription.deleted', 'evt_sub_del', { id: 'sub_1', customer: 'cus_1', status: 'canceled', current_period_start: 1_800_000_000, current_period_end: 1_802_678_400, cancel_at_period_end: false }, 400);
		expect(await handleStripeEvent(deleted as never)).toBe(true);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.plan).toBe('free');
	});

	test('a subscription refund matches a period that stored only the payment intent', async () => {
		// invoicePaymentReferences accepts either payment ref alone — a period
		// row can carry only payment_intent_id. The refund's charge arrives with
		// BOTH refs; a strict both-columns match misses the row, so the period's
		// included comments survive the refund AND the subscription-cancel
		// lookup has to fall back to the invoice index (codeant P1).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'hosted', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		await testDb().db.insert(stripeSubscriptionPeriods).values({ orgId: 'org-1', subscriptionId: 'sub_1', invoiceId: 'in_pi_only', paymentIntentId: 'pi_sub', chargeId: null, periodKey: 'p1', periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z', includedCredits: 100, consumedCredits: 0, status: 'paid' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_sub', payment_intent: 'pi_sub', amount: 500, amount_refunded: 500 });
		mocks.subscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active' });
		mocks.subscriptionsCancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' });

		expect(await reverseCharge('ch_sub', 'refund')).toBe(true);
		const period = await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in_pi_only')).get();
		expect(period?.status).toBe('refunded');
		expect(mocks.subscriptionsCancel).toHaveBeenCalledWith('sub_1');
	});

	test('a refund before invoice.paid still finds the subscription through the charge invoice', async () => {
		// No period row exists yet (refund beat the grant), but the charge's
		// invoice still names the subscription — cancel it anyway, and queue the
		// credit obligation for the grant when it lands.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_early', payment_intent: 'pi_early', amount: 500, amount_refunded: 500 });
		// Dahlia Charges carry no invoice back-link — the InvoicePayment index
		// resolves PI → invoice → subscription.
		mocks.invoicePaymentsList.mockResolvedValue({ data: [{ invoice: 'in_early', payment: { type: 'payment_intent', payment_intent: 'pi_early' } }] });
		mocks.invoicesRetrieve.mockResolvedValue({ id: 'in_early', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } } });
		mocks.subscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active' });
		mocks.subscriptionsCancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' });

		expect(await reverseCharge('ch_early', 'refund')).toBe(false); // no grant/period yet — queued
		expect(mocks.subscriptionsCancel).toHaveBeenCalledWith('sub_1');
		const pending = await testDb().db.select().from(stripePendingReversals).where(eq(stripePendingReversals.chargeId, 'ch_early')).get();
		expect(pending?.reason).toBe('refund');
	});

	test('an already-canceled subscription is not re-canceled on refund replay', async () => {
		// Idempotent: redelivery after the first cancel must not call cancel
		// again (a cancel on a canceled subscription errors at Stripe).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'hosted', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'canceled' });
		await testDb().db.insert(stripeSubscriptionPeriods).values({ orgId: 'org-1', subscriptionId: 'sub_1', invoiceId: 'in_1', paymentIntentId: 'pi_sub', chargeId: 'ch_sub', periodKey: 'p1', periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z', includedCredits: 100, consumedCredits: 0, status: 'paid' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_sub', payment_intent: 'pi_sub', amount: 500, amount_refunded: 500 });
		mocks.subscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', status: 'canceled' });

		expect(await reverseCharge('ch_sub', 'refund')).toBe(true);
		expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
	});

	test('a bundle refund never cancels the org\'s unrelated subscription', async () => {
		// Purchased credits and the subscription are independent purchases —
		// refunding a bundle reverses its credits but must leave a live
		// subscription the charge never paid for alone.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'hosted', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1', amount: 50000, amount_refunded: 50000 });

		expect(await reverseCharge('ch_1', 'refund')).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionStatus).toBe('active');
	});

	test('a refund matching no grant queues a pending reversal for when the grant lands', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_none', payment_intent: 'pi_none', amount: 50000, amount_refunded: 50000 });
		expect(await reverseCharge('ch_none', 'refund')).toBe(false);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('matched no credit grant'));
		// The obligation is durable: when the checkout grant arrives later, the
		// money that left must still take its credits.
		const pending = await testDb().db.select().from(stripePendingReversals).where(eq(stripePendingReversals.chargeId, 'ch_none')).get();
		expect(pending?.reason).toBe('refund');
		errorSpy.mockRestore();
	});
});

describe('handleStripeEvent', () => {
	test('dispatches checkout.session.completed and dedupes the delivery AT THE DISPATCHER', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session());

		const evt = event('checkout.session.completed', 'evt_1', session());
		expect(await handleStripeEvent(evt as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(500);
		// Same event id delivered again: the receipt gate short-circuits BEFORE
		// the handler — no session retrieval, no double grant, and the receipt
		// is persisted (coderabbit: the dispatcher must actually dedupe).
		expect(await handleStripeEvent(evt as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(500);
		expect(mocks.sessionsRetrieve).toHaveBeenCalledTimes(1);
		const receipt = await testDb().db.select().from(stripeEvents).where(eq(stripeEvents.eventId, 'evt_1')).get();
		expect(receipt?.eventId).toBe('evt_1');
	});

	test('a NEW event id for the SAME object re-runs the handler IDEMPOTENTLY (no double grant)', async () => {
		// Stripe can re-emit the same logical event with a new event id. The
		// receipt gate dedupes by EVENT ID only, so the second Event-object
		// reaches the handler — which is safe because the ledger's
		// UNIQUE(org, ref_type, ref_id) anchor makes fulfillment idempotent
		// (codex review: the old (type, object) gate suppressed LATER events
		// for the same object, which broke the partial→full refund path).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session());

		await handleStripeEvent(event('checkout.session.completed', 'evt_1', session()) as never);
		await handleStripeEvent(event('checkout.session.completed', 'evt_2', session()) as never);
		expect(await getCredits('org-1')).toBe(500); // never double-granted
		expect(mocks.sessionsRetrieve).toHaveBeenCalledTimes(2); // both delivered
	});

	test('a PARTIAL refund followed by a FULL refund for the same charge reverses the credits', async () => {
		// Stripe emits charge.refunded for partial refunds too, and each is a
		// DISTINCT event id. The old (event_type, object_id) dedupe suppressed
		// the later full-refund event, leaving the grant unreversed forever.
		// Dedupe by event id only, and reverseCharge itself compares amounts:
		// partial keeps the credits, the later full refund takes them (codex).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		mocks.chargesRetrieve.mockImplementation((id: string) => Promise.resolve({ id, payment_intent: 'pi_1', amount: 50000, amount_refunded: 20000 }));

		// First event: a PARTIAL refund — v1 keeps the credits.
		expect(await handleStripeEvent(event('charge.refunded', 'evt_partial', { id: 'ch_1' }) as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(500);

		// Second event: the refund now covers the FULL amount — credits go.
		mocks.chargesRetrieve.mockImplementation((id: string) => Promise.resolve({ id, payment_intent: 'pi_1', amount: 50000, amount_refunded: 50000 }));
		expect(await handleStripeEvent(event('charge.refunded', 'evt_full', { id: 'ch_1' }) as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
	});

	test('a dispute AND a later full refund both queue before the grant — both drain', async () => {
		// Both obligations can precede the delayed grant. The old charge-only
		// UNIQUE on stripe_pending_reversals dropped whichever arrived second;
		// with UNIQUE(charge_id, reason) both survive, and the drain applies
		// each on its own ledger anchor (codex review).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', autoTopupEnabled: 1, autoTopupState: 'idle' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1', amount: 50000, amount_refunded: 50000 });
		mocks.disputesRetrieve.mockResolvedValue({ id: 'du_1', charge: 'ch_1' });

		expect(await handleStripeEvent(event('charge.dispute.created', 'evt_dispute', { id: 'du_1' }) as never)).toBe(true);
		expect(await handleStripeEvent(event('charge.refunded', 'evt_refund', { id: 'ch_1' }) as never)).toBe(true);

		const pending = await testDb().db.select().from(stripePendingReversals).where(eq(stripePendingReversals.chargeId, 'ch_1')).all();
		expect(pending.map((row) => row.reason).sort()).toEqual(['dispute', 'refund']);

		// The grant lands: both obligations drain — 500 in, the dispute takes
		// it to 0, then the refund reversal floors at 0 (refunded credits zero
		// out; only dispute reversals keep a true negative for won-restore math).
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_1', payment_intent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_1' } }));
		expect(await handleStripeEvent(event('checkout.session.completed', 'evt_grant', session({ id: 'cs_1', payment_intent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_1' } })) as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		expect(await testDb().db.select().from(stripePendingReversals).where(eq(stripePendingReversals.chargeId, 'ch_1')).all()).toEqual([]);
	});

	test('a refund arriving BEFORE the grant is applied when the grant lands', async () => {
		// Stripe does not guarantee webhook delivery order: charge.refunded can
		// arrive before the checkout.session.completed that granted the money.
		// The refund must not be acked-and-forgotten — it is queued and the
		// later grant is drained so the customer never keeps credits after the
		// money left (codex 6153).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1', amount: 50000, amount_refunded: 50000 });
		expect(await handleStripeEvent(event('charge.refunded', 'evt_refund', { id: 'ch_1' }) as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		const pending = await testDb().db.select().from(stripePendingReversals).where(eq(stripePendingReversals.chargeId, 'ch_1')).get();
		expect(pending?.reason).toBe('refund');

		// The grant arrives on the next delivery: 500 in, 500 out — net zero.
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_1', payment_intent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_1' } }));
		expect(await handleStripeEvent(event('checkout.session.completed', 'evt_grant', session({ id: 'cs_1', payment_intent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_1' } })) as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		// The obligation is satisfied and gone.
		const drained = await testDb().db.select().from(stripePendingReversals).where(eq(stripePendingReversals.chargeId, 'ch_1')).get();
		expect(drained).toBeUndefined();
	});

	test('a dispute arriving BEFORE the grant disables auto top-up when the grant lands', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', autoTopupEnabled: 1, autoTopupState: 'idle' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1' });
		mocks.disputesRetrieve.mockResolvedValue({ id: 'du_1', charge: 'ch_1' });
		expect(await handleStripeEvent(event('charge.dispute.created', 'evt_dispute', { id: 'du_1' }) as never)).toBe(true);

		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_1', payment_intent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_1' } }));
		expect(await handleStripeEvent(event('checkout.session.completed', 'evt_grant', session({ id: 'cs_1', payment_intent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_1' } })) as never)).toBe(true);
		// 2000 granted, 2000 reversed; a disputed customer is never re-charged.
		expect(await getCredits('org-1')).toBe(0);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupEnabled).toBe(0);
		expect(org?.autoTopupState).toBe('disabled');
	});

	test('a card-persistence failure propagates: the event is NOT recorded and the retry completes', async () => {
		// The webhook route 500s on a thrown handler, so Stripe redelivers; the
		// receipt is only written on success. The retry must save the card
		// without double-granting (codex 6141 + coderabbit receipt gate).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session());
		mocks.customersUpdate.mockRejectedValueOnce(new Error('network blip'));

		const evt = event('checkout.session.completed', 'evt_1', session());
		await expect(handleStripeEvent(evt as never)).rejects.toThrow('could not save payment method');
		expect(await getCredits('org-1')).toBe(500);
		let receipt = await testDb().db.select().from(stripeEvents).where(eq(stripeEvents.eventId, 'evt_1')).get();
		expect(receipt).toMatchObject({ eventId: 'evt_1', processedAt: null, processingStartedAt: null, processingAttempts: 1 });

		expect(await handleStripeEvent(evt as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(500);
		receipt = await testDb().db.select().from(stripeEvents).where(eq(stripeEvents.eventId, 'evt_1')).get();
		expect(receipt?.eventId).toBe('evt_1');
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeDefaultPmId).toBe('pm_1');
	});

	test('unknown event types are logged and ignored', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await handleStripeEvent(event('invoice.created', 'evt_3', { id: 'in_1' }) as never)).toBe(false);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unhandled event type'));
		errorSpy.mockRestore();
	});

	test('dispatches charge.refunded and dispute.created', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		mocks.chargesRetrieve.mockImplementation((id: string) => Promise.resolve({ id, payment_intent: id === 'ch_1' ? 'pi_1' : 'pi_2', amount: 50000, amount_refunded: 50000 }));
		mocks.disputesRetrieve.mockResolvedValue({ id: 'du_1', charge: 'ch_2' });

		expect(await handleStripeEvent(event('charge.refunded', 'evt_4', { id: 'ch_1' }) as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_2', paymentIntentId: 'pi_2', chargeId: 'ch_2' });
		expect(await handleStripeEvent(event('charge.dispute.created', 'evt_5', { id: 'du_1' }) as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
	});

	test('a terminal failure on a tagged ungrantable refund marks the attempt and stays unprocessed', async () => {
		// A pending/requires_action refund we created is accepted as in-flight —
		// but Stripe later reports its TERMINAL status via charge.refund.updated.
		// A failed/canceled outcome means the customer is still charged for an
		// ungrantable purchase: the checkout attempt is the durable operator
		// record (session-linked refunds), and the throw keeps the event in
		// Stripe's failed-delivery queue so redeliveries keep screaming
		// MANUAL REFUND REQUIRED until a human refunds (codex P1).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.insert(stripeCheckoutAttempts).values({ attemptId: 'att_1', orgId: 'org-1', product: 'credits_500', idempotencyKey: 'checkout:att_1:k', stripeSessionId: 'cs_1' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const evt = event('charge.refund.updated', 'evt_ru_fail', { id: 're_1', object: 'refund', status: 'failed', payment_intent: 'pi_1', metadata: { reason: 'ungrantable', checkout_session_id: 'cs_1', org_id: 'org-1' } });
			await expect(handleStripeEvent(evt as never)).rejects.toThrow(/MANUAL REFUND REQUIRED/);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MANUAL REFUND REQUIRED'));
			const attempt = await testDb().db.select().from(stripeCheckoutAttempts).where(eq(stripeCheckoutAttempts.stripeSessionId, 'cs_1')).get();
			expect(attempt?.status).toBe('manual_refund_required');
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a refund.updated without the ungrantable tag is acknowledged quietly', async () => {
		// Ordinary refunds (customer-initiated, dashboard refunds) are not ours
		// to escalate — the event is handled (no retry storm) without the
		// manual-refund scream.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const evt = event('charge.refund.updated', 'evt_ru_ok', { id: 're_2', object: 'refund', status: 'succeeded', payment_intent: 'pi_2' });
			expect(await handleStripeEvent(evt as never)).toBe(true);
			expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('MANUAL REFUND REQUIRED'));
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe('portal card sync (changes made in the Stripe customer portal)', () => {
	async function orgState() {
		return testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	}

	/** Seeds org-1 with a saved top-up card; pass null to leave a column NULL. */
	async function seedOrg(overrides: Record<string, unknown> = {}) {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_1', stripeDefaultPmId: 'pm_1', autoTopupEnabled: 1, autoTopupState: 'idle', ...overrides });
	}

	function customerUpdated(id: string, defaultPm: unknown, created?: number) {
		return event('customer.updated', id, { id: 'cus_1', object: 'customer', invoice_settings: { default_payment_method: defaultPm } }, created);
	}

	function detached(id: string, paymentMethodId: string, customer: string | null = 'cus_1') {
		return event('payment_method.detached', id, { id: paymentMethodId, object: 'payment_method', customer });
	}

	/** Silences console.error for the body and hands the spy over for assertions. */
	async function withErrorSpy(body: (errorSpy: MockInstance) => Promise<void>) {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await body(errorSpy);
		} finally {
			errorSpy.mockRestore();
		}
	}

	/**
	 * Runs `sql` inside the handler's read-write window: right after it builds
	 * its first organizations UPDATE, before the builder is awaited
	 * (client.execute starts immediately; the drizzle builder is lazy).
	 */
	function injectOnFirstOrgUpdate(sql: string) {
		const realUpdate = testDb().db.update.bind(testDb().db);
		let fired = false;
		const spy = vi.spyOn(testDb().db, 'update').mockImplementation(((table: unknown) => {
			if (!fired && table === organizations) {
				fired = true;
				void testDb().client.execute(sql);
			}
			return realUpdate(table as never);
		}) as never);
		return { fired: () => fired, restore: () => spy.mockRestore() };
	}

	async function expectUnprocessed(eventId: string) {
		const receipt = await testDb().db.select().from(stripeEvents).where(eq(stripeEvents.eventId, eventId)).get();
		expect(receipt?.processedAt ?? null).toBeNull();
	}

	test('payment_method.detached for the top-up card clears it and disables auto top-up loudly', async () => {
		// The consent evidence covered the OLD card — a removed default can never
		// keep charging (same rule as savePaymentMethod's card-change branch).
		await seedOrg();
		await withErrorSpy(async (errorSpy) => {
			expect(await handleStripeEvent(detached('evt_pmd_1', 'pm_1') as never)).toBe(true);
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: null, autoTopupEnabled: 0, autoTopupState: 'disabled' });
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('pm_1'));
		});
	});

	test('payment_method.detached for another card leaves the top-up card alone', async () => {
		await seedOrg();
		expect(await handleStripeEvent(detached('evt_pmd_2', 'pm_other') as never)).toBe(true);
		expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_1', autoTopupEnabled: 1, autoTopupState: 'idle' });
	});

	test('payment_method.detached for an untracked customer is noted and acknowledged, never retried', async () => {
		// e.g. account deletion deleted the customer at Stripe — redelivery can
		// never fix this, so it must not throw (Stripe would retry for days).
		const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
		try {
			expect(await handleStripeEvent(detached('evt_pmd_3', 'pm_x', 'cus_unknown') as never)).toBe(true);
			expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('pm_x'));
		} finally {
			infoSpy.mockRestore();
		}
	});

	test('customer.updated resyncs a changed default card and disables auto top-up (fresh consent)', async () => {
		await seedOrg();
		await withErrorSpy(async (errorSpy) => {
			expect(await handleStripeEvent(customerUpdated('evt_cu_1', 'pm_2', 100) as never)).toBe(true);
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_2', autoTopupEnabled: 0, autoTopupState: 'disabled', stripeCustomerLastEventCreated: 100, stripeCustomerLastEventId: 'evt_cu_1' });
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('pm_2'));
		});
	});

	test('customer.updated with the same default card changes nothing', async () => {
		await seedOrg();
		expect(await handleStripeEvent(customerUpdated('evt_cu_2', 'pm_1', 100) as never)).toBe(true);
		expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_1', autoTopupEnabled: 1, autoTopupState: 'idle' });
	});

	test('customer.updated without a default card (e.g. the deletion e-mail scrub) changes nothing', async () => {
		// invoice_settings without the default_payment_method KEY is an unrelated
		// update (name change, e-mail scrub) — not a card change.
		await seedOrg();
		expect(await handleStripeEvent(event('customer.updated', 'evt_cu_3', { id: 'cus_1', object: 'customer', email: '', invoice_settings: {} }) as never)).toBe(true);
		expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_1', autoTopupEnabled: 1, autoTopupState: 'idle' });
	});

	test('customer.updated with an EXPLICITLY cleared default clears the org card and disables auto top-up', async () => {
		// default_payment_method: null (key present) is a real removal — the
		// default was cleared at Stripe — distinct from invoice_settings: {}
		// (key absent), which is an unrelated update like a name change. Mirror
		// the cleared state instead of leaving the pointer stale (cubic P1).
		await seedOrg();
		await withErrorSpy(async (errorSpy) => {
			expect(await handleStripeEvent(customerUpdated('evt_cu_clear', null, 100) as never)).toBe(true);
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: null, autoTopupEnabled: 0, autoTopupState: 'disabled' });
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('cleared'));
		});
	});

	test('customer.updated with an expanded default whose id is not a string throws — never stored, never processed', async () => {
		// I1/I2: a malformed signed payload ({ default_payment_method: { id: 123 } })
		// must not pass a non-string into the text column, nor be silently
		// acknowledged and marked processed (codex P2) — throw so Stripe
		// redelivers instead of freezing garbage into the org row.
		await seedOrg({ autoTopupEnabled: null, autoTopupState: null });
		await expect(handleStripeEvent(customerUpdated('evt_cu_bad', { id: 123 }, 100) as never)).rejects.toThrow('malformed');
		expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_1' });
		await expectUnprocessed('evt_cu_bad');
	});

	test('customer.updated with an empty-string default id throws', async () => {
		// '' is not a valid null-default (that is null) nor a usable card id —
		// acknowledge nothing, store nothing (codex P2).
		await seedOrg({ autoTopupEnabled: null, autoTopupState: null });
		await expect(handleStripeEvent(customerUpdated('evt_cu_empty', '', 100) as never)).rejects.toThrow('malformed');
		expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_1' });
	});

	test('a customer.updated with an invalid created timestamp throws — never stored as the cursor', async () => {
		// I2: out-of-range external data is a failed API call. A garbage-but-
		// numeric `created` (fractional, non-safe-integer, non-positive, or
		// implausibly future) persisted as the ordering cursor would mark every
		// later legitimate card update stale FOREVER (codex P2) — throw so the
		// event is never marked processed and Stripe redelivers.
		await seedOrg({ autoTopupEnabled: null, autoTopupState: null });
		const farFuture = Math.floor(Date.now() / 1000) + 7 * 86_400;
		for (const [i, bad] of [200.5, Number.MAX_SAFE_INTEGER + 1, -5, 0, farFuture].entries()) {
			await expect(handleStripeEvent(customerUpdated(`evt_cu_badts_${i}`, 'pm_2', bad) as never)).rejects.toThrow(/created/);
		}
		expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_1', stripeCustomerLastEventCreated: null });
		await expectUnprocessed('evt_cu_badts_0');
	});

	test('a stale (out-of-order) customer.updated cannot resurrect an old card', async () => {
		// Stripe does not guarantee webhook ordering: an older immutable
		// snapshot arriving after a newer one must not restore the previous
		// card (coderabbit MAJOR / cubic P1) — same ordering guard as
		// applySubscriptionSnapshot.
		await seedOrg({ autoTopupEnabled: 0, autoTopupState: 'disabled' });
		await withErrorSpy(async (errorSpy) => {
			expect(await handleStripeEvent(customerUpdated('evt_cu_new', 'pm_2', 200) as never)).toBe(true);
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_2' });
			// The older snapshot arrives LATE — it must be skipped, loudly.
			expect(await handleStripeEvent(customerUpdated('evt_cu_old', 'pm_1', 100) as never)).toBe(true);
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_2', stripeCustomerLastEventCreated: 200, stripeCustomerLastEventId: 'evt_cu_new' });
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stale'));
		});
	});

	test('same-second customer.updated events reconcile from the LIVE customer, never event-id order', async () => {
		// `created` has second precision and Stripe event ids carry no documented
		// causal order (codex P1): on a tie neither payload can be trusted as the
		// later state, so the handler fetches the live customer — the truth after
		// every change made up to the fetch. Here the SECOND event arrives with a
		// SMALLER id and a payload that disagrees with the live default; the live
		// value (pm_3) must win.
		await seedOrg({ autoTopupEnabled: 0, autoTopupState: 'disabled' });
		mocks.customersRetrieve.mockResolvedValue({ id: 'cus_1', invoice_settings: { default_payment_method: 'pm_3' } });
		await withErrorSpy(async () => {
			expect(await handleStripeEvent(customerUpdated('evt_cu_b', 'pm_2', 200) as never)).toBe(true);
			expect(await handleStripeEvent(customerUpdated('evt_cu_a', 'pm_2', 200) as never)).toBe(true);
			expect(mocks.customersRetrieve).toHaveBeenCalledWith('cus_1', { expand: ['invoice_settings.default_payment_method'] });
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_3', stripeCustomerLastEventCreated: 200, stripeCustomerLastEventId: 'evt_cu_a' });
		});
	});

	test('a failed same-second reconcile throws so Stripe redelivers — nothing stored, nothing processed', async () => {
		// The reconcile fetch IS the decision on a tie; if it fails the event must
		// not be acknowledged into a frozen stale state (I11: fail loud, retry).
		await seedOrg({ stripeDefaultPmId: 'pm_2', stripeCustomerLastEventCreated: 200, stripeCustomerLastEventId: 'evt_cu_b', autoTopupEnabled: null, autoTopupState: null });
		mocks.customersRetrieve.mockRejectedValue(new Error('stripe unavailable'));
		await withErrorSpy(async () => {
			await expect(handleStripeEvent(customerUpdated('evt_cu_a', 'pm_9', 200) as never)).rejects.toThrow('stripe unavailable');
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_2', stripeCustomerLastEventId: 'evt_cu_b' });
			await expectUnprocessed('evt_cu_a');
		});
	});

	test('a newer customer.updated with the SAME card still advances the ordering cursor', async () => {
		// If a no-change event did not advance the cursor, a stale snapshot
		// arriving after it could still resurrect the old card.
		await seedOrg({ autoTopupEnabled: 0, autoTopupState: 'disabled' });
		await withErrorSpy(async () => {
			expect(await handleStripeEvent(customerUpdated('evt_cu_new', 'pm_2', 200) as never)).toBe(true);
			expect(await handleStripeEvent(customerUpdated('evt_cu_same', 'pm_2', 300) as never)).toBe(true);
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_2', stripeCustomerLastEventCreated: 300, stripeCustomerLastEventId: 'evt_cu_same' });
			expect(await handleStripeEvent(customerUpdated('evt_cu_stale', 'pm_1', 250) as never)).toBe(true);
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_2' });
		});
	});

	test('overlapping customer.updated deliveries cannot regress the cursor or the card', async () => {
		// Distinct event ids get independent inbox leases, so nothing
		// serializes two deliveries. Both read the cursor before either writes
		// (symmetric await paths interleave FIFO); without a compare-and-set
		// predicate the OLDER write lands last and regresses both the cursor
		// and the card (codex/cubic P1).
		await seedOrg({ autoTopupEnabled: 0, autoTopupState: 'disabled' });
		const newer = customerUpdated('evt_cu_win', 'pm_2', 200);
		const older = customerUpdated('evt_cu_lose', 'pm_1', 100);
		await withErrorSpy(async () => {
			const [winResult, loseResult] = await Promise.all([handleStripeEvent(newer as never), handleStripeEvent(older as never)]);
			expect(winResult).toBe(true); // the loser is acknowledged too — redelivery cannot fix a lost race
			expect(loseResult).toBe(true);
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_2', stripeCustomerLastEventCreated: 200, stripeCustomerLastEventId: 'evt_cu_win' });
		});
	});

	test('a card change disables auto top-up even when an enable lands mid-flight', async () => {
		// The read-time `autoTopupEnabled === 1` check cannot see an owner click
		// that enables top-up INSIDE the read-write window — the write would
		// install the new card while leaving the just-enabled automation active,
		// charging a card the consent never covered (codex P1). The disable must
		// be decided atomically by the UPDATE itself, at row-lock time.
		await seedOrg({ autoTopupEnabled: 0, autoTopupState: 'idle' });
		const injection = injectOnFirstOrgUpdate("UPDATE organizations SET auto_topup_enabled = 1, auto_topup_state = 'idle' WHERE id = 'org-1'");
		try {
			await withErrorSpy(async () => {
				expect(await handleStripeEvent(customerUpdated('evt_cu_enable_race', 'pm_2', 100) as never)).toBe(true);
				expect(injection.fired()).toBe(true);
				expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_2', autoTopupEnabled: 0, autoTopupState: 'disabled' });
			});
		} finally {
			injection.restore();
		}
	});

	test('a card change with auto top-up OFF leaves the automation state untouched', async () => {
		// enabled=0/state='idle' (top-up simply off, never paused by failures) —
		// the atomic disable must not stamp 'disabled' (the failure-paused banner
		// state) onto an org that was not running the automation (codex P1).
		await seedOrg({ autoTopupEnabled: 0, autoTopupState: 'idle' });
		await withErrorSpy(async () => {
			expect(await handleStripeEvent(customerUpdated('evt_cu_off', 'pm_2', 100) as never)).toBe(true);
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_2', autoTopupEnabled: 0, autoTopupState: 'idle' });
		});
	});

	test('payment_method.detached arriving with customer: null still clears the org top-up card', async () => {
		// Stripe fires the event AFTER detachment, so the PaymentMethod's
		// customer is already null — keying the org lookup on it would leave
		// the top-up pointer stale forever (codex P1). The PM id is the key.
		await seedOrg();
		await withErrorSpy(async (errorSpy) => {
			expect(await handleStripeEvent(detached('evt_pmd_null', 'pm_1', null) as never)).toBe(true);
			expect(await orgState()).toMatchObject({ stripeDefaultPmId: null, autoTopupEnabled: 0, autoTopupState: 'disabled' });
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('pm_1'));
		});
	});

	test('a detached event whose pointer moved mid-flight cannot clear the NEW card', async () => {
		// The race, injected deterministically: the handler has read the org
		// (pointer pm_1) when a concurrent customer.updated stores pm_2 INSIDE
		// the read-write window. An update keyed only on the org id would clear
		// the valid new card (codex P1); the compare-and-set restricts the
		// clear to a pointer that still equals the detached payment-method id.
		await seedOrg();
		const injection = injectOnFirstOrgUpdate("UPDATE organizations SET stripe_default_pm_id = 'pm_2' WHERE id = 'org-1'");
		try {
			await withErrorSpy(async () => {
				expect(await handleStripeEvent(detached('evt_pmd_race', 'pm_1', null) as never)).toBe(true);
				expect(injection.fired()).toBe(true);
				expect(await orgState()).toMatchObject({ stripeDefaultPmId: 'pm_2', autoTopupEnabled: 1, autoTopupState: 'idle' });
			});
		} finally {
			injection.restore();
		}
	});
});
