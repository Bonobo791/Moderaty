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

import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';

import { env } from '$env/dynamic/private';
import { applyLedgerDelta } from '$lib/server/billing/ledger';
import { providerLedgerRef } from '$lib/server/billing/providers';
import { db } from '$lib/server/db';
import { creditTransactions, mercadoPagoCheckoutAttempts, organizations } from '$lib/server/db/schema';
import { mercadoPagoBundleById } from './bundles';
import type { MercadoPagoPayment } from './client';

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

function webhookSecret(): string {
	const secret = env.MERCADOPAGO_WEBHOOK_SECRET;
	if (!secret) throw new Error('MERCADOPAGO_WEBHOOK_SECRET is not configured');
	return secret;
}

function signaturePart(signature: string, name: string): string | null {
	const part = signature.split(',').find((item) => item.trim().startsWith(`${name}=`));
	return part ? part.trim().slice(name.length + 1) : null;
}

export function verifyWebhookSignature(headers: Headers, paymentId: string, now = Date.now()): void {
	const signature = headers.get('x-signature');
	const requestId = headers.get('x-request-id');
	if (!signature || !requestId) throw new Error('Mercado Pago webhook signature headers are missing');
	const timestamp = signaturePart(signature, 'ts');
	const provided = signaturePart(signature, 'v1');
	const timestampNumber = Number(timestamp);
	if (!timestamp || !provided || !Number.isSafeInteger(timestampNumber)) throw new Error('Mercado Pago webhook signature is malformed');
	if (Math.abs(now - timestampNumber * 1000) > MAX_SIGNATURE_AGE_MS) throw new Error('Mercado Pago webhook signature is expired');
	const manifest = `id:${paymentId};request-id:${requestId};ts:${timestamp};`;
	const expected = createHmac('sha256', webhookSecret()).update(manifest).digest('hex');
	const expectedBytes = Buffer.from(expected, 'utf8');
	const providedBytes = Buffer.from(provided, 'utf8');
	if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) {
		throw new Error('Mercado Pago webhook signature is invalid');
	}
}

function externalReference(value: string): { orgId: string; attemptId: string } {
	const separator = value.lastIndexOf(':');
	const orgId = value.slice(0, separator);
	const attemptId = value.slice(separator + 1);
	if (!/^[A-Za-z0-9_-]{8,128}$/.test(attemptId) || orgId.length === 0 || separator <= 0) {
		throw new Error('Mercado Pago payment has an invalid external reference');
	}
	return { orgId, attemptId };
}

export async function fulfillMercadoPagoPayment(payment: MercadoPagoPayment): Promise<boolean> {
	if (payment.status !== 'approved') return false;
	if (payment.currencyId !== 'BRL') throw new Error('Mercado Pago payment currency is not BRL');
	const { orgId, attemptId } = externalReference(payment.externalReference);
	const attempt = await db
		.select({
			orgId: mercadoPagoCheckoutAttempts.orgId,
			bundleId: mercadoPagoCheckoutAttempts.bundleId,
			amountCents: mercadoPagoCheckoutAttempts.amountCents,
			credits: mercadoPagoCheckoutAttempts.credits,
			paymentId: mercadoPagoCheckoutAttempts.paymentId
		})
		.from(mercadoPagoCheckoutAttempts)
		.where(eq(mercadoPagoCheckoutAttempts.attemptId, attemptId))
		.get();
	if (attempt?.orgId !== orgId) throw new Error('Mercado Pago checkout attempt was not found');
	if (attempt.paymentId && attempt.paymentId !== payment.id) throw new Error('Mercado Pago checkout attempt has a different payment');
	// The ATTEMPT ROW is the source of truth for what was agreed at checkout —
	// the live catalog env may have changed between checkout and the webhook,
	// and a mismatch must not strand a legitimately paid transaction (codex).
	if (!Number.isSafeInteger(payment.transactionAmount * 100)) throw new Error('Mercado Pago payment amount is not a whole number of cents');
	if (payment.transactionAmount * 100 !== attempt.amountCents) throw new Error('Mercado Pago payment amount does not match the checkout');
	// Pre-column attempts (credits NULL) fall back to the live catalog.
	const credits = attempt.credits ?? mercadoPagoBundleById(attempt.bundleId).credits;
	return db.transaction(async (tx) => {
		const applied = await applyLedgerDelta(tx, {
			orgId,
			delta: credits,
			reason: 'purchase',
			refType: 'checkout_session',
			refId: providerLedgerRef('mercadopago', payment.id)
		});
		const updated = await tx
			.update(mercadoPagoCheckoutAttempts)
			.set({ paymentId: payment.id, status: 'fulfilled', paidAt: new Date().toISOString(), updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` })
			.where(and(eq(mercadoPagoCheckoutAttempts.attemptId, attemptId), or(isNull(mercadoPagoCheckoutAttempts.paymentId), eq(mercadoPagoCheckoutAttempts.paymentId, payment.id))))
			.returning({ id: mercadoPagoCheckoutAttempts.id });
		if (updated.length !== 1) throw new Error('Mercado Pago checkout attempt changed while fulfilling');
		return applied;
	});
}

async function reverseMercadoPagoPayment(payment: MercadoPagoPayment, reason: 'refund' | 'dispute'): Promise<boolean> {
	// Only a REFUND must be reported in full — a chargeback reverses the whole
	// payment by definition and often arrives with NO refunded amount, which
	// must not throw forever (codex).
	if (reason === 'refund' && payment.refundedAmount !== payment.transactionAmount) {
		throw new Error('Mercado Pago payment is not a full refund');
	}
	const { orgId, attemptId } = externalReference(payment.externalReference);
	const attempt = await db
		.select({ orgId: mercadoPagoCheckoutAttempts.orgId, paymentId: mercadoPagoCheckoutAttempts.paymentId })
		.from(mercadoPagoCheckoutAttempts)
		.where(eq(mercadoPagoCheckoutAttempts.attemptId, attemptId))
		.get();
	if (attempt?.orgId !== orgId) throw new Error('Mercado Pago checkout attempt was not found');
	if (attempt.paymentId && attempt.paymentId !== payment.id) throw new Error('Mercado Pago checkout attempt has a different payment');
	const status = reason === 'refund' ? 'refunded' : 'disputed';
	const markTerminal = () =>
		db
			.update(mercadoPagoCheckoutAttempts)
			.set({ paymentId: payment.id, status, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` })
			.where(and(eq(mercadoPagoCheckoutAttempts.attemptId, attemptId), or(isNull(mercadoPagoCheckoutAttempts.paymentId), eq(mercadoPagoCheckoutAttempts.paymentId, payment.id))));
	// A payment can be BOTH charged back and refunded — the reversal is keyed
	// on the payment, not on (refType, refId), so the second terminal event
	// never subtracts the credits again (codeant HIGH). The attempt still
	// records the latest terminal state.
	const reversal = await db
		.select({ id: creditTransactions.id })
		.from(creditTransactions)
		.where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.refId, providerLedgerRef('mercadopago', payment.id)), or(eq(creditTransactions.refType, 'refund'), eq(creditTransactions.refType, 'dispute')), lt(creditTransactions.delta, 0)))
		.get();
	if (reversal) {
		await markTerminal();
		return false;
	}
	const grant = await db
		.select({ orgId: creditTransactions.orgId, delta: creditTransactions.delta })
		.from(creditTransactions)
		.where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.refType, 'checkout_session'), eq(creditTransactions.refId, providerLedgerRef('mercadopago', payment.id)), eq(creditTransactions.reason, 'purchase'), gt(creditTransactions.delta, 0)))
		.get();
	// A terminal reversal whose credits were never granted (the refund beat
	// fulfillment, or fulfillment never ran): nothing to subtract — mark the
	// attempt and stop retrying instead of throwing forever (codex).
	if (!grant) {
		await markTerminal();
		return false;
	}
	if (reason === 'dispute') {
		await db.update(organizations).set({ autoTopupEnabled: 0, autoTopupState: 'disabled' }).where(eq(organizations.id, orgId));
	}
	const reversed = await applyLedgerDelta(db, {
		orgId,
		delta: -grant.delta,
		reason,
		refType: reason,
		refId: providerLedgerRef('mercadopago', payment.id)
	});
	await markTerminal();
	return reversed;
}

export async function processMercadoPagoPayment(payment: MercadoPagoPayment): Promise<boolean> {
	if (payment.status === 'approved') return fulfillMercadoPagoPayment(payment);
	if (payment.status === 'refunded') return reverseMercadoPagoPayment(payment, 'refund');
	if (payment.status === 'charged_back') return reverseMercadoPagoPayment(payment, 'dispute');
	return false;
}
