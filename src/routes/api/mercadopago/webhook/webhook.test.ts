import { format } from 'node:util';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	verifyWebhookSignature: vi.fn(),
	retrievePayment: vi.fn(),
	processMercadoPagoPayment: vi.fn()
}));

vi.mock('$lib/server/mercadopago/webhooks', async (importOriginal) => ({
	// Spread the original so the real MercadoPagoWebhookSignatureError class is
	// available for instanceof checks while the two entry points stay mocked.
	...(await importOriginal<typeof import('$lib/server/mercadopago/webhooks')>()),
	verifyWebhookSignature: mocks.verifyWebhookSignature,
	processMercadoPagoPayment: mocks.processMercadoPagoPayment
}));
vi.mock('$lib/server/mercadopago/client', () => ({
	retrievePayment: mocks.retrievePayment
}));

import { POST } from './+server';
import { MercadoPagoWebhookSignatureError } from '$lib/server/mercadopago/webhooks';

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
		// Rendered the way console.error prints it — arg[0] is the format
		// string, later args are substituted/appended.
		logged.push(format(...args));
	});
	return logged;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.verifyWebhookSignature.mockImplementation(() => {});
	mocks.retrievePayment.mockResolvedValue({ id: 'pay-1' });
	mocks.processMercadoPagoPayment.mockResolvedValue(true);
});

afterEach(() => {
	// clearAllMocks only clears call data — the console.error spy (and its
	// stale `logged` closure) would leak into later files' tests (cubic).
	vi.restoreAllMocks();
});

test('a signature failure is a 400 — never a retriable 500', async () => {
	// A bad signature will never become valid on retry; answering 500 only
	// buys pointless Mercado Pago retries (codex).
	mocks.verifyWebhookSignature.mockImplementation(() => {
		throw new MercadoPagoWebhookSignatureError('Mercado Pago webhook signature is invalid');
	});
	const logged = captureErrors();

	const response = await POST({ request: webhookRequest('pay-1') } as never);

	expect(response.status).toBe(400);
	expect(mocks.retrievePayment).not.toHaveBeenCalled();
	expect(logged[0]).toContain('signature');
});

test('a missing webhook secret is a server-configuration error — 500, so Mercado Pago retries', async () => {
	// Only a signature MISMATCH is permanent; missing server config is a
	// deployment fault the retry can outlive, so it stays on the retriable 500
	// path (cubic, PR #136 round 3).
	mocks.verifyWebhookSignature.mockImplementation(() => {
		throw new Error('MERCADOPAGO_WEBHOOK_SECRET is not configured');
	});
	captureErrors();

	const response = await POST({ request: webhookRequest('pay-1') } as never);

	expect(response.status).toBe(500);
	expect(mocks.retrievePayment).not.toHaveBeenCalled();
});

test('a processing failure stays a 500 so Mercado Pago retries', async () => {
	mocks.retrievePayment.mockRejectedValue(new Error('connection reset by peer'));
	captureErrors();

	const response = await POST({ request: webhookRequest('pay-1') } as never);

	expect(response.status).toBe(500);
});

test('the failure log renders the caught error on one line', async () => {
	// coderabbit CWE-117: jsonResponse embeds upstream response bodies in
	// errors, so a logged `cause` can carry newlines — the rendered error
	// must be flattened, or attacker-adjacent text becomes forged log lines.
	mocks.retrievePayment.mockRejectedValue(new Error('payment retrieval failed: 502\nX-Injected-Log-Line: forged entry'));
	const logged = captureErrors();

	await POST({ request: webhookRequest('pay-1') } as never);

	expect(logged).toHaveLength(1);
	expect(logged[0]).not.toMatch(/[\r\n]/);
	expect(logged[0]).toContain('X-Injected-Log-Line'); // content survives, flattened
});

test('the failure log never carries a raw payment id (CRLF-safe, bounded)', async () => {
	// The id comes from the POST body — it is attacker-controlled text that
	// lands in the server log, so it is stripped to a safe alphabet and a
	// fixed length before logging (codex).
	mocks.retrievePayment.mockRejectedValue(new Error('boom'));
	const logged = captureErrors();

	await POST({ request: webhookRequest(`pay-1\r\nX-Injected: yes ${'a'.repeat(500)}`) } as never);

	expect(logged).toHaveLength(1);
	// The whole rendered entry is one bounded line — both the id and the
	// error are sanitized before reaching the log (coderabbit CWE-117).
	expect(logged[0]).not.toMatch(/[\r\n]/);
	expect(logged[0]).toContain('pay-1');
	expect(logged[0].length).toBeLessThan(800);
});

test('the failure log bound holds against a real worst-case error — not just a short one', async () => {
	// cubic: the cap is 128 (payment id) + 512 (error) + ~52 of literal text —
	// ≈692 rendered chars. A 'boom'-length error leaves ~120 of slack, so the
	// bound must be exercised by an error that actually overflows it.
	mocks.retrievePayment.mockRejectedValue(new Error(`forged: ${'e'.repeat(2000)}\nsecond line`));
	const logged = captureErrors();

	await POST({ request: webhookRequest(`pay-${'9'.repeat(500)}`) } as never);

	expect(logged).toHaveLength(1);
	expect(logged[0]).not.toMatch(/[\r\n]/);
	// Literal text + 128-char id cap + ': ' + 512-char error cap = ~694.
	expect(logged[0].length).toBeLessThan(700);
	expect(logged[0]).toContain('forged'); // flattened content survives the cut
});
