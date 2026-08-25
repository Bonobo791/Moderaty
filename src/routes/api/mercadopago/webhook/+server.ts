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

import { json } from '@sveltejs/kit';

import { retrievePayment } from '$lib/server/mercadopago/client';
import { processMercadoPagoPayment, verifyWebhookSignature } from '$lib/server/mercadopago/webhooks';

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
	// A signature failure is a permanent rejection, not a transient error —
	// 400, so Mercado Pago does not burn retries on a request that will never
	// become valid (codex). Genuine processing failures stay 500 (retriable).
	try {
		verifyWebhookSignature(request.headers, paymentId);
	} catch (cause) {
		console.error(`Mercado Pago webhook signature rejected for payment ${loggablePaymentId(paymentId)}:`, cause);
		return json({ error: 'Mercado Pago webhook signature rejected' }, { status: 400 });
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
