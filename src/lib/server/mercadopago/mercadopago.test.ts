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
import { setupTestDb, testDb } from '$lib/server/testdb';
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

import { createCreditPreference } from './client';
import { configuredMercadoPagoBundles } from './bundles';
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
