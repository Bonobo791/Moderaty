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

import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	verifyWebhookSignature: vi.fn(),
	retrievePayment: vi.fn(),
	processMercadoPagoPayment: vi.fn()
}));

vi.mock('$lib/server/mercadopago/webhooks', () => ({
	verifyWebhookSignature: mocks.verifyWebhookSignature,
	processMercadoPagoPayment: mocks.processMercadoPagoPayment
}));
vi.mock('$lib/server/mercadopago/client', () => ({
	retrievePayment: mocks.retrievePayment
}));

import { POST } from './+server';

function webhookRequest(paymentId: string): Request {
	return new Request('https://moderaty.example/api/mercadopago/webhook', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'payment', data: { id: paymentId } })
	});
}

function captureErrors(): string[] {
	const logged: string[] = [];
	vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		logged.push(String(args[0]));
	});
	return logged;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.verifyWebhookSignature.mockImplementation(() => {});
	mocks.retrievePayment.mockResolvedValue({ id: 'pay-1' });
	mocks.processMercadoPagoPayment.mockResolvedValue(true);
});

test('a signature failure is a 400 — never a retriable 500', async () => {
	// A bad signature will never become valid on retry; answering 500 only
	// buys pointless Mercado Pago retries (codex).
	mocks.verifyWebhookSignature.mockImplementation(() => {
		throw new Error('Mercado Pago webhook signature is invalid');
	});
	const logged = captureErrors();

	const response = await POST({ request: webhookRequest('pay-1') } as never);

	expect(response.status).toBe(400);
	expect(mocks.retrievePayment).not.toHaveBeenCalled();
	expect(logged[0]).toContain('signature');
});

test('a processing failure stays a 500 so Mercado Pago retries', async () => {
	mocks.retrievePayment.mockRejectedValue(new Error('connection reset by peer'));
	captureErrors();

	const response = await POST({ request: webhookRequest('pay-1') } as never);

	expect(response.status).toBe(500);
});

test('the failure log never carries a raw payment id (CRLF-safe, bounded)', async () => {
	// The id comes from the POST body — it is attacker-controlled text that
	// lands in the server log, so it is stripped to a safe alphabet and a
	// fixed length before logging (codex).
	mocks.retrievePayment.mockRejectedValue(new Error('boom'));
	const logged = captureErrors();

	await POST({ request: webhookRequest(`pay-1\r\nX-Injected: yes ${'a'.repeat(500)}`) } as never);

	expect(logged).toHaveLength(1);
	expect(logged[0]).not.toMatch(/[\r\n]/);
	expect(logged[0]).toContain('pay-1');
	expect(logged[0].length).toBeLessThan(250);
});
