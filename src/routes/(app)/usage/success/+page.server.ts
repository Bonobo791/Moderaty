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
import { mercadoPagoCheckoutAttempts, stripeCheckoutAttempts } from '$lib/server/db/schema';
import { retrievePayment } from '$lib/server/mercadopago/client';
import { processMercadoPagoPayment } from '$lib/server/mercadopago/webhooks';

import { markCheckoutAttemptFulfilled } from '$lib/server/billing/checkout';
import { requireUser } from '$lib/server/session';
import { getStripe } from '$lib/server/stripe/client';
import { fulfillCheckout } from '$lib/server/stripe/webhooks';

import type { PageServerLoad } from './$types';

type SessionUser = ReturnType<typeof requireUser>;
type SuccessState = {
	maintenance: boolean;
	user: SessionUser | null;
	sessionId: string | null;
	granted: boolean;
	pending: boolean;
	failed: boolean;
	/** The payment was refunded (or queued for refund) instead of granting — a deliberate outcome, not a failure. */
	refunded: boolean;
	/** The payment was taken but can never be granted and the automatic refund failed or does not exist — a human refund is required. */
	manualRefund: boolean;
};

/**
 * Mercado Pago branch: fulfill the user's own attempt idempotently. Unknown
 * attempt → failed; already fulfilled → granted; paid but unfulfilled → run
 * the same idempotent processor the webhook uses; otherwise still pending.
 */
async function mercadoPagoSuccess(user: SessionUser, attemptId: string): Promise<SuccessState> {
	const attempt = await db
		.select({ status: mercadoPagoCheckoutAttempts.status, paymentId: mercadoPagoCheckoutAttempts.paymentId })
		.from(mercadoPagoCheckoutAttempts)
		.where(and(eq(mercadoPagoCheckoutAttempts.attemptId, attemptId), eq(mercadoPagoCheckoutAttempts.orgId, user.orgId)))
		.get();
	if (!attempt) return { maintenance: false, user, sessionId: attemptId, granted: false, pending: false, failed: true, refunded: false, manualRefund: false };
	if (attempt.status === 'fulfilled') return { maintenance: false, user, sessionId: attemptId, granted: true, pending: false, failed: false, refunded: false, manualRefund: false };
	// A reversed attempt is terminal: there is no fulfillment left to wait
	// for — never leave the page pending (codex). A refund means the money
	// went back, so show that deliberately; a chargeback reads as failed.
	if (attempt.status === 'refunded') {
		return { maintenance: false, user, sessionId: attemptId, granted: false, pending: false, failed: false, refunded: true, manualRefund: false };
	}
	if (attempt.status === 'disputed') {
		return { maintenance: false, user, sessionId: attemptId, granted: false, pending: false, failed: true, refunded: false, manualRefund: false };
	}
	// A paid payment that can never be granted (the org went lifetime between
	// checkout and approval) is a durable terminal record — the buyer is still
	// charged, so the dedicated manual-refund state replaces "almost there"
	// (codex P1).
	if (attempt.status === 'manual_refund_required') {
		return { maintenance: false, user, sessionId: attemptId, granted: false, pending: false, failed: false, refunded: false, manualRefund: true };
	}
	if (attempt.paymentId) {
		try {
			await processMercadoPagoPayment(await retrievePayment(attempt.paymentId));
			// The snapshot above is stale by now: inline processing may have
			// flipped the attempt to a TERMINAL state (a refund/chargeback
			// reversal) — re-read before deciding what to render (cubic, round 3).
			const fresh = await db
				.select({ status: mercadoPagoCheckoutAttempts.status })
				.from(mercadoPagoCheckoutAttempts)
				.where(and(eq(mercadoPagoCheckoutAttempts.attemptId, attemptId), eq(mercadoPagoCheckoutAttempts.orgId, user.orgId)))
				.get();
			if (fresh?.status === 'fulfilled') return { maintenance: false, user, sessionId: attemptId, granted: true, pending: false, failed: false, refunded: false, manualRefund: false };
			if (fresh?.status === 'refunded') {
				return { maintenance: false, user, sessionId: attemptId, granted: false, pending: false, failed: false, refunded: true, manualRefund: false };
			}
			if (fresh?.status === 'disputed') {
				return { maintenance: false, user, sessionId: attemptId, granted: false, pending: false, failed: true, refunded: false, manualRefund: false };
			}
			if (fresh?.status === 'manual_refund_required') {
				return { maintenance: false, user, sessionId: attemptId, granted: false, pending: false, failed: false, refunded: false, manualRefund: true };
			}
		} catch (cause) {
			console.error('usage/success: Mercado Pago fulfillment retry failed:', cause);
		}
	}
	return { maintenance: false, user, sessionId: attemptId, granted: false, pending: true, failed: false, refunded: false, manualRefund: false };
}

/**
 * Stripe branch: retrieve the session and run the idempotent fulfillCheckout.
 * A session belonging to another org is never fulfilled (and never leaks).
 */
async function stripeSuccess(user: SessionUser, sessionId: string): Promise<SuccessState> {
	let granted = false;
	let pending = false;
	let refunded = false;
	let manualRefund = false;
	try {
		const session = await getStripe().checkout.sessions.retrieve(sessionId);
		if (session.metadata?.org_id !== user.orgId) {
			// Not this user's purchase — never fulfill (and never leak details).
			return { maintenance: false, user, sessionId, granted: false, pending: true, failed: false, refunded: false, manualRefund: false };
		}
		if (session.payment_status === 'unpaid') {
			pending = true;
		} else {
			// 'granted' (this call applied the credits) and 'already' (the
			// webhook beat the redirect — the common case) are both success; a
			// 'refunded' verdict means the session was paid but ungrantable and
			// the money was returned — deliberate, never the generic failure;
			// a 'rejected' paid session (unusable bundle metadata) must NEVER
			// report success for credits that were not granted (coderabbit).
			const result = await fulfillCheckout(sessionId);
			granted = result === 'granted' || result === 'already';
			refunded = result === 'refunded';
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
			return { maintenance: false, user, sessionId, granted: false, pending: false, failed: true, refunded: false, manualRefund: false };
		}
		// A failed or impossible automatic refund is its own state, not the
		// generic failure: 'pending' would claim money is coming back when none
		// is, and 'No purchase found' tells a still-charged buyer nothing — the
		// attempt row is marked manual_refund_required by the refund.updated
		// handler and ops is already screaming (codex P1, round 8).
		if (cause instanceof Error && cause.message.includes('MANUAL REFUND REQUIRED')) {
			return { maintenance: false, user, sessionId, granted: false, pending: false, failed: false, refunded: false, manualRefund: true };
		}
		// A transient Stripe failure can mask a terminal outcome the webhook
		// already persisted — the durable attempt record outranks the generic
		// pending fallback (codex P1, round 8).
		const attempt = await db
			.select({ status: stripeCheckoutAttempts.status })
			.from(stripeCheckoutAttempts)
			.where(and(eq(stripeCheckoutAttempts.stripeSessionId, sessionId), eq(stripeCheckoutAttempts.orgId, user.orgId)))
			.get();
		if (attempt?.status === 'manual_refund_required') {
			return { maintenance: false, user, sessionId, granted: false, pending: false, failed: false, refunded: false, manualRefund: true };
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
	return { maintenance: false, user, sessionId, granted, pending, failed: !granted && !pending && !refunded && !manualRefund, refunded, manualRefund };
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.dbDown) {
		return { maintenance: true, user: null, sessionId: null, granted: false, pending: false, failed: false, refunded: false, manualRefund: false };
	}
	const user = requireUser(locals);
	const sessionId = url.searchParams.get('session_id');
	const mercadoPagoAttemptId = url.searchParams.get('attempt_id');
	if (url.searchParams.get('provider') === 'mercadopago' && mercadoPagoAttemptId) {
		return mercadoPagoSuccess(user, mercadoPagoAttemptId);
	}
	if (!sessionId) return { maintenance: false, user, sessionId: null, granted: false, pending: false, failed: false, refunded: false, manualRefund: false };
	return stripeSuccess(user, sessionId);
};
