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
import { mercadoPagoCheckoutAttempts, organizations, stripeLifetimeEntitlements, stripeLifetimeSlots } from '$lib/server/db/schema';
import { getCredits } from '$lib/server/billing/ledger';
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

setupTestDb(['organizations', 'credit_transactions', 'stripe_events', 'mercado_pago_checkout_attempts', 'stripe_lifetime_slots', 'stripe_lifetime_entitlements']);

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
			expect(mocks.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_dup', metadata: { reason: 'ungrantable' } }, { idempotencyKey: 'refund:ungrantable:cs_dup' });
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

describe('usage/success Mercado Pago branch', () => {
	function loadMercadoPago(attemptId: string) {
		const url = new URL('/usage/success', 'http://localhost');
		url.searchParams.set('provider', 'mercadopago');
		url.searchParams.set('attempt_id', attemptId);
		return load({ locals: { user: OWNER } as never, url } as never);
	}

	test.each([
		{ status: 'refunded', expected: { granted: false, pending: false, failed: false, refunded: true } },
		{ status: 'disputed', expected: { granted: false, pending: false, failed: true, refunded: false } }
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
