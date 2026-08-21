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

import { env } from '$env/dynamic/private';

import { fetchWithRetry, jsonResponse } from '$lib/server/http';

const API_BASE = 'https://api.mercadopago.com';

export type MercadoPagoPreference = {
	id: string;
	initPoint: string;
};

export type MercadoPagoPayment = {
	id: string;
	status: string;
	externalReference: string;
	transactionAmount: number;
	currencyId: string;
};

function accessToken(): string {
	const token = env.MERCADOPAGO_ACCESS_TOKEN;
	if (!token) throw new Error('MERCADOPAGO_ACCESS_TOKEN is not configured');
	return token;
}

function environment(): 'production' | 'sandbox' {
	const value = env.MERCADOPAGO_ENVIRONMENT ?? 'production';
	if (value !== 'production' && value !== 'sandbox') {
		throw new Error('MERCADOPAGO_ENVIRONMENT must be production or sandbox');
	}
	return value;
}

function apiUrl(path: string): URL {
	return new URL(path, API_BASE);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned an invalid object`);
	return value as Record<string, unknown>;
}

export async function createCreditPreference(input: {
	orgId: string;
	attemptId: string;
	bundleId: string;
	credits: number;
	amountCents: number;
	idempotencyKey: string;
	appUrl: string;
}): Promise<MercadoPagoPreference> {
	const appUrl = new URL(input.appUrl);
	const response = await fetchWithRetry(apiUrl('/checkout/preferences'), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken()}`,
			'Content-Type': 'application/json',
			'X-Idempotency-Key': input.idempotencyKey
		},
		body: JSON.stringify({
		items: [
			{
				id: input.bundleId,
				title: `${input.credits} Moderaty comment credits`,
				quantity: 1,
				currency_id: 'BRL',
				unit_price: input.amountCents / 100
			}
		],
		external_reference: `${input.orgId}:${input.attemptId}`,
		notification_url: new URL('/api/mercadopago/webhook', appUrl).toString(),
		back_urls: {
			success: new URL(`/usage/success?provider=mercadopago&attempt_id=${encodeURIComponent(input.attemptId)}`, appUrl).toString(),
			failure: new URL('/usage?payment=failed', appUrl).toString(),
			pending: new URL('/usage?payment=pending', appUrl).toString()
		},
		auto_return: 'approved',
		metadata: { org_id: input.orgId, attempt_id: input.attemptId, bundle: input.bundleId }
	})
	});
	const body = record(await jsonResponse(response, 'Mercado Pago preference creation'), 'Mercado Pago preference');
	const initPoint = environment() === 'sandbox' ? body.sandbox_init_point : body.init_point;
	if (typeof body.id !== 'string' || body.id.length === 0) throw new Error('Mercado Pago preference has no id');
	if (typeof initPoint !== 'string' || initPoint.length === 0) throw new Error('Mercado Pago preference has no checkout URL');
	return { id: body.id, initPoint };
}

export async function retrievePayment(paymentId: string): Promise<MercadoPagoPayment> {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(paymentId)) throw new Error('Mercado Pago payment id is invalid');
	const response = await fetchWithRetry(apiUrl(`/v1/payments/${encodeURIComponent(paymentId)}`), {
		headers: { Authorization: `Bearer ${accessToken()}` }
	});
	const body = record(await jsonResponse(response, 'Mercado Pago payment lookup'), 'Mercado Pago payment');
	if (typeof body.id !== 'number' && typeof body.id !== 'string') throw new Error('Mercado Pago payment has no id');
	if (typeof body.status !== 'string' || typeof body.external_reference !== 'string') throw new Error('Mercado Pago payment has invalid status or reference');
	if (typeof body.transaction_amount !== 'number' || !Number.isFinite(body.transaction_amount) || body.transaction_amount <= 0) throw new Error('Mercado Pago payment has invalid amount');
	if (typeof body.currency_id !== 'string') throw new Error('Mercado Pago payment has invalid currency');
	return {
		id: String(body.id),
		status: body.status,
		externalReference: body.external_reference,
		transactionAmount: body.transaction_amount,
		currencyId: body.currency_id
	};
}
