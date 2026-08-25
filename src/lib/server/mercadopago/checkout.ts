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

import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { mercadoPagoCheckoutAttempts } from '$lib/server/db/schema';
import { requireOrgRole } from '$lib/server/ownership';
import type { SessionUser } from '$lib/server/session';
import { mercadoPagoProvider } from './client';
import { mercadoPagoBundleById, type MercadoPagoBundle } from './bundles';

const ATTEMPT_ID = /^[A-Za-z0-9_-]{8,128}$/;

type CheckoutAttempt = {
	attemptId: string;
	orgId: string;
	bundleId: string;
	idempotencyKey: string;
	preferenceId: string | null;
	initPoint: string | null;
	status: string;
	amountCents: number;
};

function normalizedAttemptId(value?: string): string {
	if (value === undefined || value === '') return randomUUID();
	if (!ATTEMPT_ID.test(value)) throw new Error('checkout attempt id is invalid');
	return value;
}

async function loadOrCreateAttempt(orgId: string, bundle: MercadoPagoBundle, suppliedAttemptId?: string): Promise<CheckoutAttempt> {
	const attemptId = normalizedAttemptId(suppliedAttemptId);
	const inserted = await db
		.insert(mercadoPagoCheckoutAttempts)
		.values({
			attemptId,
			orgId,
			bundleId: bundle.id,
			idempotencyKey: `mercadopago:checkout:${attemptId}:${randomUUID()}`,
			amountCents: bundle.amountCents,
			credits: bundle.credits
		})
		.onConflictDoNothing({ target: mercadoPagoCheckoutAttempts.attemptId })
		.returning({
			attemptId: mercadoPagoCheckoutAttempts.attemptId,
			orgId: mercadoPagoCheckoutAttempts.orgId,
			bundleId: mercadoPagoCheckoutAttempts.bundleId,
			idempotencyKey: mercadoPagoCheckoutAttempts.idempotencyKey,
			preferenceId: mercadoPagoCheckoutAttempts.preferenceId,
			initPoint: mercadoPagoCheckoutAttempts.initPoint,
			status: mercadoPagoCheckoutAttempts.status,
			amountCents: mercadoPagoCheckoutAttempts.amountCents
		})
		.all();
	if (inserted.length === 1) return inserted[0];
	const existing = await db
		.select({
			attemptId: mercadoPagoCheckoutAttempts.attemptId,
			orgId: mercadoPagoCheckoutAttempts.orgId,
			bundleId: mercadoPagoCheckoutAttempts.bundleId,
			idempotencyKey: mercadoPagoCheckoutAttempts.idempotencyKey,
			preferenceId: mercadoPagoCheckoutAttempts.preferenceId,
			initPoint: mercadoPagoCheckoutAttempts.initPoint,
			status: mercadoPagoCheckoutAttempts.status,
			amountCents: mercadoPagoCheckoutAttempts.amountCents
		})
		.from(mercadoPagoCheckoutAttempts)
		.where(eq(mercadoPagoCheckoutAttempts.attemptId, attemptId))
		.get();
	if (!existing) throw new Error(`Mercado Pago checkout attempt ${attemptId} disappeared while creating`);
	if (existing.orgId !== orgId || existing.bundleId !== bundle.id) throw new Error('checkout attempt does not belong to this purchase');
	if (existing.amountCents !== bundle.amountCents) throw new Error('checkout attempt price changed; start a new checkout');
	return existing;
}

export async function createMercadoPagoCreditCheckout(
	orgId: string,
	user: SessionUser,
	bundleId: string,
	attemptId?: string
): Promise<string> {
	requireOrgRole(user, 'owner');
	const appUrl = env.APP_URL;
	if (!appUrl) throw new Error('APP_URL is not configured');
	const bundle = mercadoPagoBundleById(bundleId);
	const attempt = await loadOrCreateAttempt(orgId, bundle, attemptId);
	if (attempt.status === 'fulfilled') throw new Error('Mercado Pago checkout attempt has already completed');
	// A reversed attempt is terminal too — reopening its initPoint would sell
	// credits against a payment that was already refunded or charged back.
	if (attempt.status === 'refunded' || attempt.status === 'disputed') {
		throw new Error(`Mercado Pago checkout attempt was ${attempt.status} and cannot be reused; start a new checkout`);
	}
	if (attempt.initPoint) return attempt.initPoint;
	const preference = await mercadoPagoProvider.createCheckout({
		orgId,
		attemptId: attempt.attemptId,
		bundleId: bundle.id,
		credits: bundle.credits,
		amountCents: bundle.amountCents,
		idempotencyKey: attempt.idempotencyKey,
		appUrl
	});
	const updated = await db
		.update(mercadoPagoCheckoutAttempts)
		.set({ preferenceId: preference.providerCheckoutId, initPoint: preference.checkoutUrl, status: 'open', updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` })
		.where(and(eq(mercadoPagoCheckoutAttempts.attemptId, attempt.attemptId), isNull(mercadoPagoCheckoutAttempts.preferenceId)))
		.returning({ initPoint: mercadoPagoCheckoutAttempts.initPoint });
	if (updated.length === 1 && updated[0].initPoint) return updated[0].initPoint;
	const raced = await db
		.select({ initPoint: mercadoPagoCheckoutAttempts.initPoint })
		.from(mercadoPagoCheckoutAttempts)
		.where(eq(mercadoPagoCheckoutAttempts.attemptId, attempt.attemptId))
		.get();
	if (!raced?.initPoint) throw new Error(`Mercado Pago checkout attempt ${attempt.attemptId} disappeared while saving preference`);
	return raced.initPoint;
}
