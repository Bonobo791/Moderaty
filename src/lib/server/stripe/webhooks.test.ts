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
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { setupTestDb, testDb } from '$lib/server/testdb';
import { db } from '$lib/server/db';
import { organizations, stripeEvents, stripePendingReversals } from '$lib/server/db/schema';
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

setupTestDb(['organizations', 'credit_transactions', 'stripe_events', 'stripe_pending_reversals']);

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

		// Fully refunded charge: reject, never grant.
		mocks.sessionsRetrieve.mockResolvedValue(
			session({
				payment_intent: { id: 'pi_1', latest_charge: { id: 'ch_1', disputed: false, amount: 50000, amount_refunded: 50000 }, payment_method: 'pm_1' }
			})
		);
		expect(await fulfillCheckout('cs_1')).toBe('rejected');
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
		mocks.disputesRetrieve.mockResolvedValue({ id: 'du_1', charge: 'ch_1', status: 'won' });
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

		// The grant lands: both obligations drain — 500 in, 1000 out (net -500;
		// a negative balance is the documented v1 consequence of reversing
		// credits the customer already spent).
		mocks.sessionsRetrieve.mockResolvedValue(session({ id: 'cs_1', payment_intent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_1' } }));
		expect(await handleStripeEvent(event('checkout.session.completed', 'evt_grant', session({ id: 'cs_1', payment_intent: { id: 'pi_1', latest_charge: 'ch_1', payment_method: 'pm_1' } })) as never)).toBe(true);
		expect(await getCredits('org-1')).toBe(-500);
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
		expect(receipt).toBeUndefined();

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
});
