// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
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

// Checkout success landing. The WEBHOOK is the authoritative fulfillment
// path; this page just runs the same idempotent fulfillCheckout for instant
// credits (research note §2: Checkout waits ~10s for the webhook, so the
// redirect alone is never enough). Fulfillment only runs for the signed-in
// user's OWN org — a session id belonging to another org is never fulfilled
// here, and any retrieval failure is logged loudly and left to the webhook.

import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { mercadoPagoCheckoutAttempts } from '$lib/server/db/schema';
import { retrievePayment } from '$lib/server/mercadopago/client';
import { processMercadoPagoPayment } from '$lib/server/mercadopago/webhooks';

import { markCheckoutAttemptFulfilled } from '$lib/server/billing/checkout';
import { requireUser } from '$lib/server/session';
import { getStripe } from '$lib/server/stripe/client';
import { fulfillCheckout } from '$lib/server/stripe/webhooks';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.dbDown) {
		return { maintenance: true, user: null, sessionId: null, granted: false, pending: false, failed: false };
	}
	const user = requireUser(locals);
	const sessionId = url.searchParams.get('session_id');
	const provider = url.searchParams.get('provider');
	const mercadoPagoAttemptId = url.searchParams.get('attempt_id');
	if (provider === 'mercadopago' && mercadoPagoAttemptId) {
		const attempt = await db
			.select({ status: mercadoPagoCheckoutAttempts.status, paymentId: mercadoPagoCheckoutAttempts.paymentId })
			.from(mercadoPagoCheckoutAttempts)
			.where(and(eq(mercadoPagoCheckoutAttempts.attemptId, mercadoPagoAttemptId), eq(mercadoPagoCheckoutAttempts.orgId, user.orgId)))
			.get();
		if (!attempt) return { maintenance: false, user, sessionId: mercadoPagoAttemptId, granted: false, pending: false, failed: true };
		if (attempt.status === 'fulfilled') return { maintenance: false, user, sessionId: mercadoPagoAttemptId, granted: true, pending: false, failed: false };
		if (attempt.paymentId) {
			try {
				const applied = await processMercadoPagoPayment(await retrievePayment(attempt.paymentId));
				return { maintenance: false, user, sessionId: mercadoPagoAttemptId, granted: applied || attempt.status === 'fulfilled', pending: !applied, failed: false };
			} catch (cause) {
				console.error('usage/success: Mercado Pago fulfillment retry failed:', cause);
			}
		}
		return { maintenance: false, user, sessionId: mercadoPagoAttemptId, granted: false, pending: true, failed: false };
	}
	if (!sessionId) return { maintenance: false, user, sessionId: null, granted: false, pending: false, failed: false };
	let granted = false;
	let pending = false;
	try {
		const session = await getStripe().checkout.sessions.retrieve(sessionId);
		if (session.metadata?.org_id !== user.orgId) {
			// Not this user's purchase — never fulfill (and never leak details).
			return { maintenance: false, user, sessionId, granted: false, pending: true, failed: false };
		}
		if (session.payment_status === 'unpaid') {
			pending = true;
		} else {
			// 'granted' (this call applied the credits) and 'already' (the
			// webhook beat the redirect — the common case) are both success; a
			// 'rejected' paid session (unusable bundle metadata) must NEVER
			// report success for credits that were not granted (coderabbit).
			const result = await fulfillCheckout(sessionId);
			granted = result === 'granted' || result === 'already';
			if (granted) await markCheckoutAttemptFulfilled(sessionId);
		}
	} catch (cause) {
		// A session id that does not EXIST is a definitive no-purchase, not a
		// pending payment: Stripe answers an StripeInvalidRequestError with
		// code resource_missing for unknown ids, and the webhook will never
		// fulfill it either — the page must show the failed/no-purchase state
		// instead of claiming "Payment received" for a session that never was
		// (codex review).
		const isMissingSession =
			cause !== null &&
			typeof cause === 'object' &&
			(cause as { type?: unknown }).type === 'StripeInvalidRequestError' &&
			(cause as { code?: unknown }).code === 'resource_missing';
		if (isMissingSession) {
			console.error(
				`usage/success: checkout session ${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}… does not exist — no purchase to show`
			);
			return { maintenance: false, user, sessionId, granted: false, pending: false, failed: true };
		}
		// A TRANSIENT retrieval failure is different: the webhook remains the
		// source of truth; log loudly and show pending. The session id is
		// query-controlled and the provider error can carry payment details —
		// the log stays restricted: a fixed failure category and a short hash
		// of the id for correlation, never the raw error text (coderabbit).
		console.error(
			`usage/success: could not fulfill checkout (session ${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}…) — see the stripe webhook logs`
		);
		pending = true;
	}
	return { maintenance: false, user, sessionId, granted, pending, failed: !granted && !pending };
};
