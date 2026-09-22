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

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { creditTransactions, mercadoPagoCheckoutAttempts, organizations, stripeCheckoutAttempts, stripeEvents, stripeLifetimeEntitlements, stripeLifetimeSlots } from '$lib/server/db/schema';
import { applyLedgerDelta, getCredits } from '$lib/server/billing/ledger';
import { handleStripeEvent } from '$lib/server/stripe/webhooks';
import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	sessionsRetrieve: vi.fn(),
	refundsCreate: vi.fn(),
	retrievePayment: vi.fn()
}));

vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => ({
		checkout: { sessions: { retrieve: mocks.sessionsRetrieve } },
		refunds: { create: mocks.refundsCreate }
	})
}));
vi.mock('$lib/server/mercadopago/client', () => ({
	retrievePayment: mocks.retrievePayment
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { load } from './+page.server';

setupTestDb(['organizations', 'credit_transactions', 'stripe_events', 'mercado_pago_checkout_attempts', 'stripe_checkout_attempts', 'stripe_lifetime_slots', 'stripe_lifetime_entitlements', 'stripe_pending_reversals']);

const OWNER = TEST_OWNER;

function paidSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'cs_1',
		payment_status: 'paid',
		metadata: { org_id: 'org-1', bundle: 'credits_500' },
		...overrides
	};
}

function loadWith(sessionId: string | null) {
	// Build from a fixed base URL; the query value goes through searchParams
	// (repo guideline: new URL(path, base), never interpolation — coderabbit).
	const url = new URL('/usage/success', 'http://localhost');
	if (sessionId !== null) url.searchParams.set('session_id', sessionId);
	return load({ locals: { user: OWNER } as never, url } as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.refundsCreate.mockResolvedValue({ id: 're_1', status: 'succeeded' });
});

describe('usage/success load', () => {
	test('grants the credits when the user lands before the webhook', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidSession());

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(true);
		expect(data.pending).toBe(false);
		expect(data.failed).toBe(false);
		expect(await getCredits('org-1')).toBe(500);
	});

	test('a paid session already granted by the webhook still shows success (never "No purchase found")', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidSession());
		// First load: the page grants. Second load (refresh): the webhook has
		// also granted — fulfillCheckout is an idempotent no-op.
		await loadWith('cs_1');
		expect(await getCredits('org-1')).toBe(500);

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(true);
		expect(data.failed).toBe(false);
		expect(await getCredits('org-1')).toBe(500); // still exactly once
	});

	test('an unpaid session stays pending', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidSession({ payment_status: 'unpaid' }));

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(false);
		expect(data.pending).toBe(true);
		expect(data.failed).toBe(false);
	});

	test('a paid session with missing/invalid bundle metadata FAILS — never a fake success', async () => {
		// fulfillCheckout returns 'rejected' for a paid session whose bundle
		// metadata is unusable: the page must NOT report success for credits
		// that were never granted (coderabbit — the old boolean fallback
		// `fulfillCheckout() || payment_status === 'paid'` showed success for
		// any paid session, even when nothing was credited).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidSession({ metadata: { org_id: 'org-1', bundle: 'credits_999999' } }));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(false);
		expect(data.pending).toBe(false);
		expect(data.failed).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		errorSpy.mockRestore();
	});

	test('a paid checkout that cannot grant shows the refunded state, never "No purchase found"', async () => {
		// A duplicate/sold-out lifetime checkout refunds the payment — the
		// buyer must see a refunded outcome, not a generic failure (review).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'lifetime' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1', activeEntitlementId: 1 }).where(eq(stripeLifetimeSlots.slot, 1));
		await testDb().db.insert(stripeLifetimeEntitlements).values({ id: 1, orgId: 'org-1', slot: 1, checkoutSessionId: 'cs_first' });
		mocks.sessionsRetrieve.mockResolvedValue(
			paidSession({ id: 'cs_dup', mode: 'payment', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_dup', latest_charge: 'ch_dup' } })
		);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const data = (await loadWith('cs_dup')) as { granted: boolean; pending: boolean; failed: boolean; refunded: boolean };
			expect(data.granted).toBe(false);
			expect(data.failed).toBe(false);
			expect(data.refunded).toBe(true);
			expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_dup', metadata: { reason: 'ungrantable', org_id: 'org-1', checkout_session_id: 'cs_dup' } }, { idempotencyKey: 'refund:ungrantable:cs_dup' });
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a failed automatic refund shows the manual-refund state — never pending or "No purchase found"', async () => {
		// The refund resolved terminally FAILED at Stripe: pending claims money
		// is coming back when none is, and the generic failure reads as "no
		// purchase" to a buyer who was in fact charged — the honest state is
		// the dedicated manual-refund message (codex P1).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'lifetime' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1', activeEntitlementId: 1 }).where(eq(stripeLifetimeSlots.slot, 1));
		await testDb().db.insert(stripeLifetimeEntitlements).values({ id: 1, orgId: 'org-1', slot: 1, checkoutSessionId: 'cs_first' });
		mocks.sessionsRetrieve.mockResolvedValue(
			paidSession({ id: 'cs_dup', mode: 'payment', metadata: { org_id: 'org-1', product: 'lifetime' }, payment_intent: { id: 'pi_dup', latest_charge: 'ch_dup' } })
		);
		mocks.refundsCreate.mockResolvedValue({ id: 're_1', status: 'failed' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const data = (await loadWith('cs_dup')) as { granted: boolean; pending: boolean; failed: boolean; refunded: boolean; manualRefund: boolean };
			expect(data.manualRefund).toBe(true);
			expect(data.failed).toBe(false);
			expect(data.pending).toBe(false);
			expect(data.refunded).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a persisted manual_refund_required attempt surfaces even when the session retrieve fails transiently', async () => {
		// The webhook-side refund.updated handler already marked the attempt —
		// a transient Stripe outage must not mask that durable record behind
		// the generic pending state (codex P1).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.insert(stripeCheckoutAttempts).values({
			attemptId: 'att_1',
			orgId: 'org-1',
			product: 'lifetime',
			idempotencyKey: 'checkout:att_1:k',
			stripeSessionId: 'cs_1',
			status: 'manual_refund_required'
		});
		mocks.sessionsRetrieve.mockRejectedValue(new Error('Connection reset by peer'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const data = (await loadWith('cs_1')) as { pending: boolean; manualRefund: boolean };
			expect(data.manualRefund).toBe(true);
			expect(data.pending).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a retrieval failure logs a fixed category and a truncated id — never the raw error or full session id', async () => {
		// The session id is query-controlled and the provider error can carry
		// payment details — the log must stay restricted (coderabbit).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockRejectedValue(new Error('Connection reset by peer while retrieving session (transient)'));

		const logged: string[] = [];
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
			logged.push(String(args[0]));
		});
		try {
			const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };
			expect(data.pending).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain('could not fulfill checkout');
		expect(logged[0]).not.toContain('cs_1');
		expect(logged[0]).not.toContain('transient');
	});

	test('a MISSING checkout session shows the failed state — never a false "payment received"', async () => {
		// The session id is query-controlled: a bogus id must not be presented
		// as a pending/successful payment. Stripe answers an
		// StripeInvalidRequestError with code resource_missing for an unknown
		// session — that is a definitive no-purchase, not a transient
		// fulfillment failure (codex review).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockRejectedValue({
			type: 'StripeInvalidRequestError',
			code: 'resource_missing',
			message: 'No such checkout session: cs_does_not_exist'
		});

		const data = (await loadWith('cs_does_not_exist')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(false);
		expect(data.pending).toBe(false);
		expect(data.failed).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
	});

	test('a session for ANOTHER org is never fulfilled here', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidSession({ metadata: { org_id: 'org-other', bundle: 'credits_500' } }));

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean };

		expect(data.granted).toBe(false);
		expect(data.pending).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
	});
});

describe('usage/success test-checkout branch', () => {
	// codex P1: the STRIPE_TEST_PRODUCT smoke test exists to prove the
	// deployment's webhook pipeline. If the success-page redirect fulfilled
	// the session itself, a broken webhook endpoint would look green — so the
	// test branch only OBSERVES, it never fulfills.
	function paidTestSession(overrides: Record<string, unknown> = {}) {
		return paidSession({
			mode: 'payment',
			metadata: { org_id: 'org-1', product: 'test' },
			payment_intent: { id: 'pi_t', latest_charge: { id: 'ch_t', amount: 100, amount_refunded: 0, refunded: false }, payment_method: null },
			customer: 'cus_1',
			...overrides
		});
	}

	test('a paid test checkout is observed, never fulfilled — pending until the webhook grants', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidTestSession());

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean; test: boolean };

		expect(data.test).toBe(true);
		expect(data.granted).toBe(false);
		expect(data.pending).toBe(true);
		expect(data.failed).toBe(false);
		// The credit is NOT granted by the page — only the webhook's own
		// fulfillCheckout may write it.
		expect(await getCredits('org-1')).toBe(0);
	});

	test('a test checkout shows granted once the webhook fulfillment landed', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidTestSession());
		// The real webhook path: claim the delivery, fulfill, mark the
		// attempt fulfilled, mark the event processed — the pass signal the
		// observer trusts is the processed stripe_events row.
		expect(
			await handleStripeEvent({ id: 'evt_t', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } } as never)
		).toBe(true);
		expect(await getCredits('org-1')).toBe(1);

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; test: boolean };

		expect(data.test).toBe(true);
		expect(data.granted).toBe(true);
		expect(data.pending).toBe(false);
		expect(await getCredits('org-1')).toBe(1); // still exactly once
	});

	test('a committed grant with no processed webhook event stays pending — never self-completes', async () => {
		// codex P1 round 2: fulfillCreditPurchase commits the ledger grant
		// BEFORE savePaymentMethod — a failing card save leaves the row while
		// the event stays unprocessed and retrying. The grant alone must NOT
		// read as a passed smoke test, and the page must never write the
		// webhook-owned 'fulfilled' attempt status itself.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.insert(stripeCheckoutAttempts).values({
			attemptId: 'att_t',
			orgId: 'org-1',
			product: 'test',
			idempotencyKey: 'checkout:att_t:k',
			stripeSessionId: 'cs_1',
			status: 'open'
		});
		await applyLedgerDelta(testDb().db, { orgId: 'org-1', delta: 1, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1' });
		mocks.sessionsRetrieve.mockResolvedValue(paidTestSession());

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; test: boolean };

		expect(data.test).toBe(true);
		expect(data.granted).toBe(false);
		expect(data.pending).toBe(true);
		// The attempt stays 'open' — only the webhook's own handler may mark
		// it fulfilled; nothing the observer writes can fake that signal.
		const attempt = await testDb().db
			.select({ status: stripeCheckoutAttempts.status })
			.from(stripeCheckoutAttempts)
			.where(eq(stripeCheckoutAttempts.stripeSessionId, 'cs_1'))
			.get();
		expect(attempt?.status).toBe('open');
	});

	test('a processed event with no grant stays pending — the refunded path needs the charge', async () => {
		// The event proves the delivery was HANDLED; the credit outcome is
		// still read from the ledger/charge — a processed event alone is not
		// a grant verdict.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.insert(stripeEvents).values({
			eventId: 'evt_t',
			eventType: 'checkout.session.completed',
			objectId: 'cs_1',
			objectType: 'checkout.session',
			processedAt: '2026-01-01T00:00:00.000Z'
		});
		mocks.sessionsRetrieve.mockResolvedValue(paidTestSession());

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; test: boolean };

		expect(data.test).toBe(true);
		expect(data.granted).toBe(false);
		expect(data.pending).toBe(true);
	});

	test('a test checkout refunded by the webhook shows the refunded state', async () => {
		// An unmetered org's paid test exercises the ungrantable→refund path —
		// observed from the charge state, never by self-fulfilling.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'lifetime' });
		mocks.sessionsRetrieve.mockResolvedValue(
			paidTestSession({ payment_intent: { id: 'pi_t', latest_charge: { id: 'ch_t', amount: 100, amount_refunded: 100, refunded: true }, payment_method: null } })
		);

		const data = (await loadWith('cs_1')) as { granted: boolean; refunded: boolean; pending: boolean; test: boolean };

		expect(data.test).toBe(true);
		expect(data.refunded).toBe(true);
		expect(data.granted).toBe(false);
		expect(data.pending).toBe(false);
	});

	test('a test checkout whose refund failed terminally shows the manual-refund state', async () => {
		// The webhook's refund.updated handler marks the attempt durable —
		// the page reads it instead of sitting pending forever.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'lifetime' });
		await testDb().db.insert(stripeCheckoutAttempts).values({
			attemptId: 'att_t',
			orgId: 'org-1',
			product: 'test',
			idempotencyKey: 'checkout:att_t:k',
			stripeSessionId: 'cs_1',
			status: 'manual_refund_required'
		});
		mocks.sessionsRetrieve.mockResolvedValue(paidTestSession());

		const data = (await loadWith('cs_1')) as { manualRefund: boolean; pending: boolean; test: boolean };

		expect(data.test).toBe(true);
		expect(data.manualRefund).toBe(true);
		expect(data.pending).toBe(false);
	});

	test('a no_payment_required test session is a failed smoke test, not pending', async () => {
		// A $0-completed test checkout can never verify the paid pipeline —
		// zero-priced Prices are rejected at creation, so only a stale session
		// reaches this. It must read as a failure, not "waiting for webhook".
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.sessionsRetrieve.mockResolvedValue(paidTestSession({ payment_status: 'no_payment_required' }));

		const data = (await loadWith('cs_1')) as { granted: boolean; pending: boolean; failed: boolean; test: boolean };

		expect(data.test).toBe(true);
		expect(data.failed).toBe(true);
		expect(data.pending).toBe(false);
		expect(await getCredits('org-1')).toBe(0);
	});
});

describe('usage/success Mercado Pago branch', () => {
	function loadMercadoPago(attemptId: string) {
		const url = new URL('/usage/success', 'http://localhost');
		url.searchParams.set('provider', 'mercadopago');
		url.searchParams.set('attempt_id', attemptId);
		return load({ locals: { user: OWNER } as never, url } as never);
	}

	test.each([
		{ status: 'refunded', expected: { granted: false, pending: false, failed: false, refunded: true, manualRefund: false } },
		{ status: 'disputed', expected: { granted: false, pending: false, failed: true, refunded: false, manualRefund: false } },
		// A paid payment that can never be granted (lifetime upgrade raced the
		// approval) is recorded for a human refund — the buyer sees the
		// dedicated manual-refund state, not pending forever (codex P1).
		{ status: 'manual_refund_required', expected: { granted: false, pending: false, failed: false, refunded: false, manualRefund: true } }
	])('a $status attempt is terminal — a deliberate verdict, never pending, and never re-retrieved', async ({ status, expected }) => {
		// A reversed payment has no fulfillment left to wait for: the page must
		// show a terminal state immediately instead of pending forever (codex).
		// A refund is a deliberate outcome — the buyer gets the refunded state,
		// not the generic failure (review); a chargeback still reads as failed.
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.insert(mercadoPagoCheckoutAttempts).values({
			attemptId: 'attempt_1',
			orgId: 'org-1',
			bundleId: 'credits_100',
			idempotencyKey: 'mp-key',
			amountCents: 500,
			status,
			paymentId: 'pay-1'
		});

		const data = (await loadMercadoPago('attempt_1')) as { granted: boolean; pending: boolean; failed: boolean; refunded: boolean };

		expect(data).toMatchObject(expected);
		expect(mocks.retrievePayment).not.toHaveBeenCalled();
	});

	test.each([
		{ paymentStatus: 'refunded', expected: { granted: false, pending: false, failed: false, refunded: true } },
		{ paymentStatus: 'charged_back', expected: { granted: false, pending: false, failed: true, refunded: false } }
	])('a pending attempt whose inline processing lands a $paymentStatus reversal shows its verdict — never stale pending', async ({ paymentStatus, expected }) => {
		// The attempt snapshot is read BEFORE processMercadoPagoPayment runs; a
		// refund/chargeback processed inline flips the row to terminal, and the
		// page must decide from the post-processing state (cubic, round 3).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.insert(mercadoPagoCheckoutAttempts).values({
			attemptId: 'attempt_1',
			orgId: 'org-1',
			bundleId: 'credits_100',
			idempotencyKey: 'mp-key',
			amountCents: 500,
			status: 'open',
			paymentId: 'pay-1'
		});
		mocks.retrievePayment.mockResolvedValue({
			id: 'pay-1',
			status: paymentStatus,
			externalReference: 'org-1:attempt_1',
			transactionAmount: 5,
			refundedAmount: 5,
			currencyId: 'BRL'
		});

		const data = (await loadMercadoPago('attempt_1')) as { granted: boolean; pending: boolean; failed: boolean; refunded: boolean };

		expect(data).toMatchObject(expected);
	});
});
