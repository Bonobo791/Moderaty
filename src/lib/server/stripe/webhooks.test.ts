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
import { db } from '$lib/server/db';
import { organizations } from '$lib/server/db/schema';
import { applyLedgerDelta, getCredits } from '$lib/server/billing/ledger';
import { fulfillAutoTopup, fulfillCheckout, handleStripeEvent, restoreWonDispute, reverseCharge, reverseDispute } from './webhooks';

const mocks = vi.hoisted(() => ({
	sessionsRetrieve: vi.fn(),
	paymentIntentsRetrieve: vi.fn(),
	chargesRetrieve: vi.fn(),
	disputesRetrieve: vi.fn(),
	customersUpdate: vi.fn(),
	paymentMethodsAttach: vi.fn()
}));

vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => ({
		checkout: { sessions: { retrieve: mocks.sessionsRetrieve } },
		paymentIntents: { retrieve: mocks.paymentIntentsRetrieve },
		charges: { retrieve: mocks.chargesRetrieve },
		disputes: { retrieve: mocks.disputesRetrieve },
		customers: { update: mocks.customersUpdate },
		paymentMethods: { attach: mocks.paymentMethodsAttach }
	})
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

setupTestDb(['organizations', 'credit_transactions', 'stripe_events']);

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'cs_123',
		payment_status: 'paid',
		metadata: { org_id: 'org-1', bundle: 'credits_500' },
		customer: 'cus_1',
		payment_intent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_1' },
		...overrides
	};
}

function event(type: string, id: string, object: Record<string, unknown>): { id: string; type: string; data: { object: unknown } } {
	return { id, type, data: { object: { id, object: 'test', ...object } } };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('fulfillCheckout', () => {
	test('grants the bundle credits and saves the card as default', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session());

		const applied = await fulfillCheckout('cs_123');

		expect(applied).toBe(true);
		expect(await getCredits('org-1')).toBe(500);
		// Checkout returns the payment_method as an ID string (not expanded):
		// no attach call, the default_payment_method is set directly.
		expect(mocks.paymentMethodsAttach).not.toHaveBeenCalled();
		expect(mocks.customersUpdate).toHaveBeenCalledWith('cus_1', { invoice_settings: { default_payment_method: 'pm_1' } });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeCustomerId).toBe('cus_1');
		expect(org?.stripeDefaultPmId).toBe('pm_1');
	});

	test('is idempotent: a duplicate delivery never double-grants', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session());

		expect(await fulfillCheckout('cs_123')).toBe(true);
		expect(await fulfillCheckout('cs_123')).toBe(false);
		expect(await getCredits('org-1')).toBe(500);
	});

	test('never credits an unpaid session', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session({ payment_status: 'unpaid' }));

		expect(await fulfillCheckout('cs_123')).toBe(false);
		expect(await getCredits('org-1')).toBe(0);
	});

	test('fails loudly when metadata is missing — never credits the wrong org', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.sessionsRetrieve.mockResolvedValue(session({ metadata: {} }));

		expect(await fulfillCheckout('cs_123')).toBe(false);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no org_id/bundle metadata'));
		errorSpy.mockRestore();
	});

	test('an unknown bundle id fails loudly', async () => {
		mocks.sessionsRetrieve.mockResolvedValue(session({ metadata: { org_id: 'org-1', bundle: 'credits_999999' } }));
		await expect(fulfillCheckout('cs_123')).rejects.toThrow('unknown credit bundle');
	});

	test('a card-save failure never blocks the grant', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session());
		mocks.customersUpdate.mockRejectedValue(new Error('rate limited'));

		expect(await fulfillCheckout('cs_123')).toBe(true);
		expect(await getCredits('org-1')).toBe(500);
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

	test('a dispute reversal and a later refund can never reverse twice (shared charge anchor)', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await applyLedgerDelta(db, { orgId: 'org-1', delta: 2000, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' });
		mocks.disputesRetrieve.mockResolvedValue({ id: 'du_1', charge: 'ch_1' });
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1' });

		expect(await reverseDispute('du_1')).toBe(true);
		// The refund arrives after the dispute reversal: the grant is already
		// gone, so nothing more can be reversed — the balance never goes negative.
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
		mocks.disputesRetrieve.mockResolvedValue({ id: 'du_1', charge: 'ch_1', status: 'won' });
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

	test('a refund matching no grant logs loudly and reverses nothing', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.chargesRetrieve.mockResolvedValue({ id: 'ch_none', payment_intent: 'pi_none', amount: 50000, amount_refunded: 50000 });
		expect(await reverseCharge('ch_none', 'refund')).toBe(false);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('matched no credit grant'));
		errorSpy.mockRestore();
	});
});

describe('handleStripeEvent', () => {
	test('dispatches checkout.session.completed and dedupes the delivery', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session());

		const evt = event('checkout.session.completed', 'evt_1', session());
		expect(await handleStripeEvent(evt as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(500);
		// Same event id delivered again: the handler re-runs (idempotent via the
		// ledger anchor) and the event is then recorded — no double grant.
		expect(await handleStripeEvent(evt as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(500);
		expect(mocks.sessionsRetrieve).toHaveBeenCalledTimes(2);
	});

	test('a NEW event id for the SAME object still dedupes (two-Event-objects case)', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(session());

		await handleStripeEvent(event('checkout.session.completed', 'evt_1', session()) as never);
		await handleStripeEvent(event('checkout.session.completed', 'evt_2', session()) as never);
		expect(await getCredits('org-1')).toBe(500);
		expect(mocks.sessionsRetrieve).toHaveBeenCalledTimes(2);
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
});
