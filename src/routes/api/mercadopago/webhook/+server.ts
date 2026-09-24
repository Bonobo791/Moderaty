import { json } from '@sveltejs/kit';

import { retrievePayment } from '$lib/server/mercadopago/client';
import { MercadoPagoWebhookSignatureError, processMercadoPagoPayment, verifyWebhookSignature } from '$lib/server/mercadopago/webhooks';

// The payment id arrives in the POST body — attacker-controlled text that
// must never reach the server log raw (CRLF injection, unbounded length).
function loggablePaymentId(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128) || '[invalid]';
}

export async function POST({ request }) {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return json({ error: 'invalid webhook payload' }, { status: 400 });
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return json({ error: 'invalid webhook payload' }, { status: 400 });
	}
	const body = payload as { type?: unknown; data?: { id?: unknown } };
	if (body.type !== 'payment') return json({ ok: true, ignored: true });
	if (typeof body.data?.id !== 'string' && typeof body.data?.id !== 'number') {
		return json({ error: 'payment webhook has no payment id' }, { status: 400 });
	}
	const paymentId = String(body.data.id);
	// A signature MISMATCH is a permanent rejection, not a transient error —
	// 400, so Mercado Pago does not burn retries on a request that will never
	// become valid (codex). Missing server CONFIGURATION (no webhook secret) or
	// an unexpected verifier failure is a deployment fault a retry can outlive
	// — it must stay on the retriable 500 path (cubic, round 3).
	try {
		verifyWebhookSignature(request.headers, paymentId);
	} catch (cause) {
		if (cause instanceof MercadoPagoWebhookSignatureError) {
			console.error(`Mercado Pago webhook signature rejected for payment ${loggablePaymentId(paymentId)}:`, cause);
			return json({ error: 'Mercado Pago webhook signature rejected' }, { status: 400 });
		}
		console.error(`Mercado Pago webhook signature could not be verified for payment ${loggablePaymentId(paymentId)}:`, cause);
		return json({ error: 'Mercado Pago webhook processing failed' }, { status: 500 });
	}
	try {
		const payment = await retrievePayment(paymentId);
		const applied = await processMercadoPagoPayment(payment);
		return json({ ok: true, applied });
	} catch (cause) {
		console.error(`Mercado Pago webhook failed for payment ${loggablePaymentId(paymentId)}:`, cause);
		return json({ error: 'Mercado Pago webhook processing failed' }, { status: 500 });
	}
}
