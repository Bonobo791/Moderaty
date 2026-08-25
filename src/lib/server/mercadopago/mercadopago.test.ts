// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Advanced Digital Marketing LTDA
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

import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { organizations, mercadoPagoCheckoutAttempts, creditTransactions } from '$lib/server/db/schema';
import { setupTestDb, testDb, TEST_OWNER } from '$lib/server/testdb';
import { providerLedgerRef } from '$lib/server/billing/providers';

const mocks = vi.hoisted(() => ({
	env: {
		MERCADOPAGO_ACCESS_TOKEN: 'app-token',
		MERCADOPAGO_WEBHOOK_SECRET: 'webhook-secret',
		MERCADOPAGO_ENVIRONMENT: 'sandbox',
		MERCADOPAGO_PRICE_CREDITS_100_BRL_CENTS: '500',
		MERCADOPAGO_PRICE_CREDITS_500_BRL_CENTS: '1900',
		MERCADOPAGO_PRICE_CREDITS_2000_BRL_CENTS: '5900',
		APP_URL: 'https://moderaty.example'
	}
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { createCreditPreference, retrievePayment } from './client';
import { configuredMercadoPagoBundles } from './bundles';
import { createMercadoPagoCreditCheckout } from './checkout';
import { fulfillMercadoPagoPayment, processMercadoPagoPayment, verifyWebhookSignature } from './webhooks';

setupTestDb(['organizations', 'credit_transactions', 'mercado_pago_checkout_attempts']);

const payment = {
	id: 'pay-1',
	status: 'approved',
	externalReference: 'org-1:attempt_1',
	transactionAmount: 5,
	refundedAmount: 0,
	currencyId: 'BRL'
};

beforeEach(async () => {
	vi.restoreAllMocks();
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'One', creditsRemaining: 0 });
	await testDb().db.insert(mercadoPagoCheckoutAttempts).values({
		attemptId: 'attempt_1',
		orgId: 'org-1',
		bundleId: 'credits_100',
		idempotencyKey: 'mp-key',
		amountCents: 500
	});
});

test('uses a provider-prefixed ledger reference and rejects unsafe payment ids', () => {
	expect(providerLedgerRef('mercadopago', 'pay-1')).toBe('mercadopago:pay-1');
	expect(() => providerLedgerRef('mercadopago', 'pay:1')).toThrow(/payment id is invalid/);
});

test('lists only configured BRL bundles with whole-cent prices', () => {
	expect(configuredMercadoPagoBundles().map((bundle) => [bundle.id, bundle.amountCents])).toEqual([
		['credits_100', 500],
		['credits_500', 1900],
		['credits_2000', 5900]
	]);
});

test('creates a sandbox preference with a stable external reference and BRL amount', async () => {
	const fetchMock = vi.fn().mockResolvedValue(
		new Response(JSON.stringify({ id: 'pref-1', sandbox_init_point: 'https://sandbox.mercadopago.test/pref-1' }), { status: 201 })
	);
	vi.stubGlobal('fetch', fetchMock);
	const result = await createCreditPreference({
		orgId: 'org-1',
		attemptId: 'attempt_1',
		bundleId: 'credits_100',
		credits: 100,
		amountCents: 500,
		idempotencyKey: 'mp-key',
		appUrl: 'https://moderaty.example'
	});
	expect(result).toEqual({ id: 'pref-1', initPoint: 'https://sandbox.mercadopago.test/pref-1' });
	const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
	expect(url.toString()).toBe('https://api.mercadopago.com/checkout/preferences');
	expect(init.headers).toMatchObject({ Authorization: 'Bearer app-token', 'X-Idempotency-Key': 'mp-key' });
	expect(JSON.parse(String(init.body))).toMatchObject({
		external_reference: 'org-1:attempt_1',
		items: [{ currency_id: 'BRL', unit_price: 5, quantity: 1 }]
	});
});

test('accepts only a fresh, correctly signed webhook manifest', () => {
	const now = 1_700_000_000_000;
	const ts = String(Math.floor(now / 1000));
	const manifest = `id:pay-1;request-id:req-1;ts:${ts};`;
	const digest = createHmac('sha256', 'webhook-secret').update(manifest).digest('hex');
	const headers = new Headers({ 'x-request-id': 'req-1', 'x-signature': `ts=${ts},v1=${digest}` });
	expect(() => verifyWebhookSignature(headers, 'pay-1', now)).not.toThrow();
	expect(() => verifyWebhookSignature(new Headers({ 'x-request-id': 'req-1', 'x-signature': `ts=${ts},v1=${'0'.repeat(64)}` }), 'pay-1', now)).toThrow(/invalid/);
});

test('fulfills an approved payment exactly once through the credit ledger', async () => {
	expect(await fulfillMercadoPagoPayment(payment)).toBe(true);
	expect(await fulfillMercadoPagoPayment(payment)).toBe(false);
	const org = await testDb().db.select({ creditsRemaining: organizations.creditsRemaining }).from(organizations).where(eq(organizations.id, 'org-1')).get();
	const rows = await testDb().db.select().from(creditTransactions).where(and(eq(creditTransactions.orgId, 'org-1'), eq(creditTransactions.refId, 'mercadopago:pay-1')));
	expect(org?.creditsRemaining).toBe(100);
	expect(rows).toHaveLength(1);
});

test('rejects a payment whose amount does not match the persisted attempt', async () => {
	await expect(fulfillMercadoPagoPayment({ ...payment, transactionAmount: 4.99 })).rejects.toThrow(/amount does not match/);
	const org = await testDb().db.select({ creditsRemaining: organizations.creditsRemaining }).from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.creditsRemaining).toBe(0);
});

test('reverses a full Mercado Pago refund exactly once after the approved grant', async () => {
	expect(await processMercadoPagoPayment(payment)).toBe(true);
	expect(await processMercadoPagoPayment({ ...payment, status: 'refunded', refundedAmount: 5 })).toBe(true);
	expect(await processMercadoPagoPayment({ ...payment, status: 'refunded', refundedAmount: 5 })).toBe(false);
	const org = await testDb().db.select({ creditsRemaining: organizations.creditsRemaining }).from(organizations).where(eq(organizations.id, 'org-1')).get();
	const rows = await testDb().db.select().from(creditTransactions).where(and(eq(creditTransactions.orgId, 'org-1'), eq(creditTransactions.reason, 'refund')));
	expect(org?.creditsRemaining).toBe(0);
	expect(rows).toHaveLength(1);
	expect(rows[0].delta).toBe(-100);
});

test('does not reverse a partial Mercado Pago refund', async () => {
	await processMercadoPagoPayment(payment);
	await expect(processMercadoPagoPayment({ ...payment, status: 'refunded', refundedAmount: 4 })).rejects.toThrow(/full refund/);
});

async function attemptRow() {
	return testDb().db.select().from(mercadoPagoCheckoutAttempts).where(eq(mercadoPagoCheckoutAttempts.attemptId, 'attempt_1')).get();
}

async function ledgerRows() {
	return testDb().db.select().from(creditTransactions).where(and(eq(creditTransactions.orgId, 'org-1'), eq(creditTransactions.refId, 'mercadopago:pay-1')));
}

test('a chargeback followed by a refund for the same payment reverses the grant exactly once', async () => {
	// Idempotency must key on the PAYMENT, not on (refType, refId): both a
	// dispute and a refund can arrive for one payment, and each would subtract
	// the credits again if keyed separately (codeant HIGH).
	expect(await processMercadoPagoPayment(payment)).toBe(true);
	expect(await processMercadoPagoPayment({ ...payment, status: 'charged_back' })).toBe(true);
	expect(await processMercadoPagoPayment({ ...payment, status: 'refunded', refundedAmount: 5 })).toBe(false);

	const rows = await ledgerRows();
	expect(rows).toHaveLength(2);
	expect(rows.filter((row) => row.delta < 0)).toHaveLength(1);
	const org = await testDb().db.select({ creditsRemaining: organizations.creditsRemaining }).from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.creditsRemaining).toBe(0);
	// The attempt still records the LATEST terminal state even though no
	// second delta was inserted.
	expect((await attemptRow())?.status).toBe('refunded');
});

test('reverses a chargeback even when Mercado Pago reports no refunded amount', async () => {
	// A chargeback reverses the full payment by definition — requiring
	// refundedAmount === transactionAmount makes every chargeback without a
	// refund amount throw forever (codex).
	expect(await processMercadoPagoPayment(payment)).toBe(true);
	expect(await processMercadoPagoPayment({ ...payment, status: 'charged_back', refundedAmount: 0 })).toBe(true);

	const rows = await ledgerRows();
	expect(rows.filter((row) => row.delta < 0)).toMatchObject([{ delta: -100, reason: 'dispute' }]);
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.creditsRemaining).toBe(0);
	expect(org?.autoTopupEnabled).toBe(0);
	expect((await attemptRow())?.status).toBe('disputed');
});

test('a refund for a terminal payment whose credits were never granted is processed without a delta', async () => {
	// The refund webhook can beat fulfillment (or the payment was reversed
	// before the grant landed): there is nothing to subtract, so mark the
	// attempt and stop retrying instead of throwing forever (codex).
	expect(await processMercadoPagoPayment({ ...payment, status: 'refunded', refundedAmount: 5 })).toBe(false);

	expect(await ledgerRows()).toHaveLength(0);
	const attempt = await attemptRow();
	expect(attempt?.status).toBe('refunded');
	expect(attempt?.paymentId).toBe('pay-1');
	const org = await testDb().db.select({ creditsRemaining: organizations.creditsRemaining }).from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.creditsRemaining).toBe(0);
});

test('rejects a payment amount that is not whole cents instead of rounding it', async () => {
	// Math.round would mask a malformed 5.005 (500.4999… cents) as a valid
	// 500 — external amounts must be exact or the call fails loudly (I2).
	await expect(fulfillMercadoPagoPayment({ ...payment, transactionAmount: 5.005 })).rejects.toThrow(/whole number of cents/);
	expect(await ledgerRows()).toHaveLength(0);
});

test('grants the credits persisted on the attempt even when the catalog price changed since checkout', async () => {
	// The webhook may arrive long after checkout; fulfillment must not depend
	// on the LIVE price env still matching the attempt (codex).
	await testDb().db.update(mercadoPagoCheckoutAttempts).set({ credits: 100 }).where(eq(mercadoPagoCheckoutAttempts.attemptId, 'attempt_1'));
	mocks.env.MERCADOPAGO_PRICE_CREDITS_100_BRL_CENTS = '99900';
	try {
		expect(await fulfillMercadoPagoPayment(payment)).toBe(true);
	} finally {
		mocks.env.MERCADOPAGO_PRICE_CREDITS_100_BRL_CENTS = '500';
	}
	const org = await testDb().db.select({ creditsRemaining: organizations.creditsRemaining }).from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.creditsRemaining).toBe(100);
});

test('falls back to the catalog credits for attempts created before the credits column existed', async () => {
	expect(await fulfillMercadoPagoPayment(payment)).toBe(true);
	const org = await testDb().db.select({ creditsRemaining: organizations.creditsRemaining }).from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.creditsRemaining).toBe(100);
});

test('a payment lookup whose id does not match the requested payment fails loudly', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
		new Response(JSON.stringify({ id: 999999, status: 'approved', external_reference: 'org-1:attempt_1', transaction_amount: 5, currency_id: 'BRL' }), { status: 200 })
	));
	await expect(retrievePayment('pay-1')).rejects.toThrow(/different payment/);
});

test('a refunded or disputed checkout attempt is terminal and never reopened', async () => {
	for (const status of ['refunded', 'disputed'] as const) {
		await testDb().db.update(mercadoPagoCheckoutAttempts).set({ status, initPoint: `https://mp.test/${status}` }).where(eq(mercadoPagoCheckoutAttempts.attemptId, 'attempt_1'));
		await expect(createMercadoPagoCreditCheckout('org-1', TEST_OWNER, 'credits_100', 'attempt_1')).rejects.toThrow(new RegExp(status));
	}
});

test('a bundle with a malformed configured price is logged loudly and skipped, never thrown', async () => {
	// The usage page must stay up with the valid bundles when one price env is
	// malformed — a config error is not a database outage (codex/cubic).
	mocks.env.MERCADOPAGO_PRICE_CREDITS_500_BRL_CENTS = 'not-a-number';
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		expect(configuredMercadoPagoBundles().map((bundle) => [bundle.id, bundle.amountCents])).toEqual([
			['credits_100', 500],
			['credits_2000', 5900]
		]);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('credits_500'), expect.anything());
	} finally {
		mocks.env.MERCADOPAGO_PRICE_CREDITS_500_BRL_CENTS = '1900';
		errorSpy.mockRestore();
	}
});
