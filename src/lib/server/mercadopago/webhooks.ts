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
import { and, eq, gt, isNull, lt, notInArray, or, sql } from 'drizzle-orm';

import { env } from '$env/dynamic/private';
import { applyLedgerDelta } from '$lib/server/billing/ledger';
import { providerLedgerRef } from '$lib/server/billing/providers';
import { db } from '$lib/server/db';
import { creditTransactions, mercadoPagoCheckoutAttempts, organizations } from '$lib/server/db/schema';
import { mercadoPagoBundleById } from './bundles';
import type { MercadoPagoPayment } from './client';

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/**
 * A permanent webhook-REQUEST rejection: the signature headers are missing,
 * malformed, expired, or simply wrong — the request can never become valid on
 * retry (400). Distinct from server-CONFIGURATION errors (a missing secret),
 * which are retriable 500s (cubic, PR #136 round 3).
 */
export class MercadoPagoWebhookSignatureError extends Error {}

export function webhookSecret(): string {
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
	if (!signature || !requestId) throw new MercadoPagoWebhookSignatureError('Mercado Pago webhook signature headers are missing');
	const timestamp = signaturePart(signature, 'ts');
	const provided = signaturePart(signature, 'v1');
	const timestampNumber = Number(timestamp);
	if (!timestamp || !provided || !Number.isSafeInteger(timestampNumber)) throw new MercadoPagoWebhookSignatureError('Mercado Pago webhook signature is malformed');
	if (Math.abs(now - timestampNumber * 1000) > MAX_SIGNATURE_AGE_MS) throw new MercadoPagoWebhookSignatureError('Mercado Pago webhook signature is expired');
	const manifest = `id:${paymentId};request-id:${requestId};ts:${timestamp};`;
	const expected = createHmac('sha256', webhookSecret()).update(manifest).digest('hex');
	const expectedBytes = Buffer.from(expected, 'utf8');
	const providedBytes = Buffer.from(provided, 'utf8');
	if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) {
		throw new MercadoPagoWebhookSignatureError('Mercado Pago webhook signature is invalid');
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

// Binary floating point cannot represent most decimal prices: 19.99 * 100 is
// 1998.9999999999998. Accept an amount within representation error of a whole
// cent and use the rounded integer; a genuinely fractional-cent amount
// (5.005 → 500.5000…1, distance 0.5) still fails loudly (I2 — never clamp
// external money, cubic round 3).
function paymentAmountCents(transactionAmount: number): number {
	const raw = transactionAmount * 100;
	const rounded = Math.round(raw);
	if (!Number.isFinite(raw) || Math.abs(raw - rounded) >= 1e-6) {
		throw new Error('Mercado Pago payment amount is not a whole number of cents');
	}
	return rounded;
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
	if (paymentAmountCents(payment.transactionAmount) !== attempt.amountCents) throw new Error('Mercado Pago payment amount does not match the checkout');
	// Mercado Pago reports a PARTIAL refund as `approved` with
	// 0 < refunded_amount < transaction_amount — granting the full credits
	// would ack money already partly returned. Partial refunds are rejected for
	// manual review (DEPLOY.md §3): throw so the webhook 500s and nothing is
	// granted (codex/cubic, round 4). A refunded amount covering the whole
	// approved payment is out of contract entirely — a full refund arrives as
	// status `refunded` (I2).
	if (payment.refundedAmount !== 0) {
		if (paymentAmountCents(payment.refundedAmount) >= paymentAmountCents(payment.transactionAmount)) {
			throw new Error('Mercado Pago approved payment has an out-of-contract refunded amount');
		}
		throw new Error('Mercado Pago payment has a partial refund — rejected for manual review');
	}
	// Pre-column attempts (credits NULL) fall back to the live catalog.
	const credits = attempt.credits ?? mercadoPagoBundleById(attempt.bundleId).credits;
	return db.transaction(async (tx) => {
		// Claim the terminal transition BEFORE granting: a concurrent reversal
		// may have flipped the attempt to refunded/disputed after the read above
		// — granting then would resurrect credits the reversal just took, and an
		// unconditional status write would erase the terminal record (cubic/codex,
		// round 3). Idempotent replays of an already-fulfilled payment re-claim
		// successfully ('fulfilled' is not excluded).
		const claimed = await tx
			.update(mercadoPagoCheckoutAttempts)
			.set({ paymentId: payment.id, status: 'fulfilled', paidAt: new Date().toISOString(), updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` })
			.where(
				and(
					eq(mercadoPagoCheckoutAttempts.attemptId, attemptId),
					or(isNull(mercadoPagoCheckoutAttempts.paymentId), eq(mercadoPagoCheckoutAttempts.paymentId, payment.id)),
					notInArray(mercadoPagoCheckoutAttempts.status, ['refunded', 'disputed'])
				)
			)
			.returning({ id: mercadoPagoCheckoutAttempts.id });
		if (claimed.length !== 1) {
			const current = await tx
				.select({ status: mercadoPagoCheckoutAttempts.status, paymentId: mercadoPagoCheckoutAttempts.paymentId })
				.from(mercadoPagoCheckoutAttempts)
				.where(eq(mercadoPagoCheckoutAttempts.attemptId, attemptId))
				.get();
			// The reversal won the race: the terminal state stands, nothing is
			// granted, and the webhook acks — there is nothing left to retry.
			if (current?.paymentId === payment.id && (current.status === 'refunded' || current.status === 'disputed')) return false;
			throw new Error('Mercado Pago checkout attempt changed while fulfilling');
		}
		return applyLedgerDelta(tx, {
			orgId,
			delta: credits,
			reason: 'purchase',
			refType: 'checkout_session',
			refId: providerLedgerRef('mercadopago', payment.id)
		});
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
		.select({
			orgId: mercadoPagoCheckoutAttempts.orgId,
			paymentId: mercadoPagoCheckoutAttempts.paymentId,
			amountCents: mercadoPagoCheckoutAttempts.amountCents,
			currency: mercadoPagoCheckoutAttempts.currency
		})
		.from(mercadoPagoCheckoutAttempts)
		.where(eq(mercadoPagoCheckoutAttempts.attemptId, attemptId))
		.get();
	if (attempt?.orgId !== orgId) throw new Error('Mercado Pago checkout attempt was not found');
	if (attempt.paymentId && attempt.paymentId !== payment.id) throw new Error('Mercado Pago checkout attempt has a different payment');
	// The reversal revokes the credits THIS attempt granted — a self-consistent
	// but WRONG refunded lookup (R$1 reported for a R$5 attempt) must fail
	// loudly instead of revoking the full entitlement (codex, round 3).
	if (payment.currencyId !== attempt.currency) throw new Error('Mercado Pago payment currency does not match the checkout');
	if (paymentAmountCents(payment.transactionAmount) !== attempt.amountCents) throw new Error('Mercado Pago payment amount does not match the checkout');
	const status = reason === 'refund' ? 'refunded' : 'disputed';
	// The dedupe check and the ledger insert are ONE transaction: a concurrent
	// refund + chargeback would otherwise both pass the pre-check before either
	// commits, and their different refTypes bypass the ledger uniqueness key —
	// a double subtraction (cubic/codex, round 3). Inside the transaction the
	// second writer either sees the committed row or fails loudly on the
	// database write lock; both can never apply.
	return db.transaction(async (tx) => {
		const markTerminal = () =>
			tx
				.update(mercadoPagoCheckoutAttempts)
				.set({ paymentId: payment.id, status, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` })
				.where(and(eq(mercadoPagoCheckoutAttempts.attemptId, attemptId), or(isNull(mercadoPagoCheckoutAttempts.paymentId), eq(mercadoPagoCheckoutAttempts.paymentId, payment.id))));
		// A disputed customer must never be re-charged off-session. This applies
		// on EVERY dispute delivery — including one deduped by a prior refund,
		// where skipping it would leave the org eligible after a chargeback
		// (codex, round 3).
		const disableAutoTopup = async () => {
			if (reason !== 'dispute') return;
			await tx.update(organizations).set({ autoTopupEnabled: 0, autoTopupState: 'disabled' }).where(eq(organizations.id, orgId));
		};
		// A payment can be BOTH charged back and refunded — the reversal is keyed
		// on the payment, not on (refType, refId), so the second terminal event
		// never subtracts the credits again (codeant HIGH). The attempt still
		// records the latest terminal state.
		const reversal = await tx
			.select({ id: creditTransactions.id })
			.from(creditTransactions)
			.where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.refId, providerLedgerRef('mercadopago', payment.id)), or(eq(creditTransactions.refType, 'refund'), eq(creditTransactions.refType, 'dispute')), lt(creditTransactions.delta, 0)))
			.get();
		if (reversal) {
			await disableAutoTopup();
			await markTerminal();
			return false;
		}
		const grant = await tx
			.select({ orgId: creditTransactions.orgId, delta: creditTransactions.delta })
			.from(creditTransactions)
			.where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.refType, 'checkout_session'), eq(creditTransactions.refId, providerLedgerRef('mercadopago', payment.id)), eq(creditTransactions.reason, 'purchase'), gt(creditTransactions.delta, 0)))
			.get();
		// A terminal reversal whose credits were never granted (the refund beat
		// fulfillment, or fulfillment never ran): nothing to subtract — mark the
		// attempt and stop retrying instead of throwing forever (codex). The
		// dispute side effect still applies: a chargeback with no grant is a
		// chargeback all the same (codex/cubic, round 4).
		if (!grant) {
			await disableAutoTopup();
			await markTerminal();
			return false;
		}
		await disableAutoTopup();
		const reversed = await applyLedgerDelta(tx, {
			orgId,
			delta: -grant.delta,
			reason,
			refType: reason,
			refId: providerLedgerRef('mercadopago', payment.id)
		});
		await markTerminal();
		return reversed;
	});
}

export async function processMercadoPagoPayment(payment: MercadoPagoPayment): Promise<boolean> {
	if (payment.status === 'approved') return fulfillMercadoPagoPayment(payment);
	if (payment.status === 'refunded') return reverseMercadoPagoPayment(payment, 'refund');
	if (payment.status === 'charged_back') return reverseMercadoPagoPayment(payment, 'dispute');
	return false;
}
