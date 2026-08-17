// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// Stripe webhook event handling. Every handler is idempotent:
//  1. stripe_events dedupes the delivery (event_id UNIQUE, plus
//     UNIQUE(event_type, object_id) for Stripe's two-Event-objects case).
//  2. credit grants are anchored on UNIQUE(org_id, ref_type, ref_id) in the
//     ledger, so even a dedupe miss cannot double-credit.
// The stripe_events row and the ledger mutation land in ONE transaction; a
// crash rolls both back and Stripe's retry re-runs the whole thing safely.

import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';

import { db } from '$lib/server/db';
import { organizations, creditTransactions, stripeEvents } from '$lib/server/db/schema';
import { applyLedgerDelta, findGrantForStripe } from '$lib/server/billing/ledger';
import { grantAutoTopupCredits, handleAutoTopupFailure } from '$lib/server/billing/autotopup';
import { bundleById, type CreditBundle } from '$lib/server/stripe/bundles';
import { getStripe } from '$lib/server/stripe/client';

/**
 * Records a Stripe event when it has not already been recorded.
 *
 * @param event - The Stripe event to record
 * @returns `true` if the event was newly recorded, `false` if it was already recorded
 */
async function recordEvent(event: Stripe.Event): Promise<boolean> {
	const object = event.data.object;
	const objectId = typeof object === 'object' && object !== null && 'id' in object ? String(object.id) : String(object);
	const objectType = typeof object === 'object' && object !== null && 'object' in object ? String(object.object) : 'unknown';
	// ON CONFLICT DO NOTHING without a target covers BOTH unique anchors: the
	// event id (duplicate delivery) and the (event_type, object_id) pair
	// (Stripe's two-Event-objects case).
	const inserted = await db
		.insert(stripeEvents)
		.values({ eventId: event.id, eventType: event.type, objectId, objectType })
		.onConflictDoNothing()
		.returning({ id: stripeEvents.id });
	return inserted.length === 1;
}

/**
 * Gets the credit amount defined by a bundle.
 *
 * @param bundle - The credit bundle
 * @returns The bundle's credit amount
 */
function creditsForBundle(bundle: CreditBundle): number {
	return bundle.credits;
}

/**
 * Fulfills a paid Checkout Session: grants the purchased credits and saves
 * the card for future auto top-ups. Called from the webhook (authoritative)
 * and from the success page (instant UX) — both paths are idempotent.
 * Only payment_status 'paid' grants: 'processing' (delayed-notification
 * methods) must wait for async_payment_succeeded, and no_payment_required
 * (a $0 session) grants nothing.
 */
export async function fulfillCheckout(sessionId: string): Promise<boolean> {
	const session = await getStripe().checkout.sessions.retrieve(sessionId, {
		expand: ['payment_intent']
	});
	if (session.payment_status !== 'paid') return false;
	const orgId = session.metadata?.org_id;
	const bundleId = session.metadata?.bundle;
	if (!orgId || !bundleId) {
		console.error(`stripe: checkout session ${sessionId} has no org_id/bundle metadata — cannot credit`);
		return false;
	}
	const bundle = bundleById(bundleId);
	// expand: ['payment_intent'] returns the full object; the type stays a
	// string-union, so narrow before touching nested fields.
	const paymentIntent = typeof session.payment_intent === 'string' ? null : session.payment_intent;
	const applied = await applyLedgerDelta(db, {
		orgId,
		delta: creditsForBundle(bundle),
		reason: 'purchase',
		refType: 'checkout_session',
		refId: sessionId,
		paymentIntentId: paymentIntent?.id,
		chargeId: typeof paymentIntent?.latest_charge === 'string' ? paymentIntent.latest_charge : undefined
	});
	// Save the card used for this payment as the customer's default, so a
	// later auto top-up can charge it off-session. This runs even when the
	// grant was already applied (duplicate delivery): a transient first-
	// delivery failure must be retried by the next delivery or success-page
	// refresh, or the org would permanently have no top-up card. Every step
	// is idempotent (attach, default-payment-method update, org row update).
	const paymentMethod = paymentIntent?.payment_method;
	const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
	if (paymentMethod && customer) {
		try {
			if (typeof paymentMethod !== 'string') {
				await getStripe().paymentMethods.attach(paymentMethod.id, { customer });
			}
			const paymentMethodId = typeof paymentMethod === 'string' ? paymentMethod : paymentMethod.id;
			await getStripe().customers.update(customer, { invoice_settings: { default_payment_method: paymentMethodId } });
			await db
				.update(organizations)
				.set({ stripeCustomerId: customer, stripeDefaultPmId: paymentMethodId })
				.where(eq(organizations.id, orgId));
		} catch (error) {
			// The credits are already granted; failing to save the card only
			// disables future auto top-up — never fail the fulfillment for it.
			console.error(`stripe: could not save payment method for ${orgId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return applied;
}

/**
 * Grants credits for a successful auto-top-up payment.
 *
 * @param paymentIntentId - The Stripe PaymentIntent identifier
 * @returns `true` if credits were granted, `false` if the payment was ineligible
 */
export async function fulfillAutoTopup(paymentIntentId: string): Promise<boolean> {
	const pi = await getStripe().paymentIntents.retrieve(paymentIntentId);
	if (pi.status !== 'succeeded') return false;
	if (pi.metadata?.type !== 'auto_topup') return false;
	const orgId = pi.metadata?.org_id;
	if (!orgId) {
		console.error(`stripe: auto-topup PI ${paymentIntentId} has no org_id metadata`);
		return false;
	}
	return grantAutoTopupCredits(orgId, pi);
}

/**
 * Reverses credits granted for a refunded or disputed charge. Each path
 * anchors on its OWN refType — 'refund' for refunds, 'dispute' for disputes
 * (refId = charge id) — so the full lifecycle applies exactly once per step:
 * a dispute reversal, a won-dispute restore (refType 'dispute', refId =
 * dispute id), and a later legitimate full refund each clear their own anchor
 * and can never block or double-apply one another. The reason field
 * ('refund' vs 'dispute') keeps the ledger legible.
 *
 * @param chargeId - The Stripe charge identifier
 * @param reason - Whether the reversal is for a refund or dispute
 * @returns `true` if a reversal was applied, `false` if no matching credit grant was found or the reversal was already recorded
 */
export async function reverseCharge(chargeId: string, reason: 'refund' | 'dispute'): Promise<boolean> {
	const charge = await getStripe().charges.retrieve(chargeId, { expand: ['payment_intent'] });
	const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
	// v1 policy (docs/stripe-checkout-webhooks.md §7): credits are reversed
	// only on a FULL refund. Stripe's charge.refunded fires for partial
	// refunds too — compare the refunded and original amounts, and treat a
	// charge without usable amounts as NOT fully refunded (never take credits
	// away on ambiguous data; log loudly instead).
	if (reason === 'refund') {
		const fullyRefunded =
			typeof charge.amount_refunded === 'number' &&
			typeof charge.amount === 'number' &&
			charge.amount_refunded >= charge.amount;
		if (!fullyRefunded) {
			console.error(
				`stripe: refund for ${chargeId} is not a full refund (refunded ${charge.amount_refunded ?? 'unknown'} of ${charge.amount ?? 'unknown'}) — credits kept (v1 reverses only full refunds)`
			);
			return false;
		}
	}
	const match = await findGrantForStripe(db, { chargeId, paymentIntentId });
	if (!match) {
		console.error(`stripe: ${reason} for ${chargeId} matched no credit grant — nothing to reverse`);
		return false;
	}
	// The grant may already have been reversed — each path's own anchor
	// (refType 'refund' or 'dispute', refId = charge id) makes the reversal
	// apply at most once per path.
	return applyLedgerDelta(db, {
		orgId: match.orgId,
		delta: -match.credits,
		reason,
		refType: reason === 'refund' ? 'refund' : 'dispute',
		refId: chargeId,
		chargeId,
		paymentIntentId
	});
}

/**
 * Reverses credits associated with a disputed charge, and disables the org's
 * automatic top-up: a customer who disputed a charge must never be re-charged
 * off-session by the sweep (docs/stripe-auto-topup.md §7 — "mark the customer's
 * auto top-up disabled pending review"). Re-enabling is a fresh, explicit owner
 * action on the Usage page.
 *
 * @param disputeId - The Stripe dispute identifier
 * @returns `true` if the credit reversal was applied, `false` otherwise
 */
export async function reverseDispute(disputeId: string): Promise<boolean> {
	const dispute = await getStripe().disputes.retrieve(disputeId);
	const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
	if (!chargeId) {
		console.error(`stripe: dispute ${disputeId} has no charge`);
		return false;
	}
	// The org is identified through the grant (a dispute on a charge that
	// never granted credits has no org to disable — logged by reverseCharge).
	const match = await findGrantForStripe(db, { chargeId });
	if (match) {
		await db
			.update(organizations)
			.set({ autoTopupEnabled: 0, autoTopupState: 'disabled' })
			.where(eq(organizations.id, match.orgId));
	}
	return reverseCharge(chargeId, 'dispute');
}

/**
 * Restores credits reversed for a charge when its dispute is won.
 *
 * @param disputeId - The Stripe dispute identifier
 * @returns `true` if credits were restored, `false` if the dispute is not won, no matching grant or reversal exists, or the restoration was already applied
 */
export async function restoreWonDispute(disputeId: string): Promise<boolean> {
	const dispute = await getStripe().disputes.retrieve(disputeId);
	if (dispute.status !== 'won') return false;
	const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
	if (!chargeId) return false;
	const match = await findGrantForStripe(db, { chargeId });
	if (!match) {
		console.error(`stripe: won dispute ${disputeId} matched no grant — nothing to restore`);
		return false;
	}
	// Only restore when this dispute actually reversed credits: a lost
	// dispute.created delivery must not turn a won event into a double grant.
	const reversal = await db
		.select({ id: creditTransactions.id })
		.from(creditTransactions)
		.where(
			and(
				eq(creditTransactions.orgId, match.orgId),
				eq(creditTransactions.reason, 'dispute'),
				eq(creditTransactions.chargeId, chargeId)
			)
		)
		.get();
	if (!reversal) return false;
	return applyLedgerDelta(db, {
		orgId: match.orgId,
		delta: match.credits,
		reason: 'adjust',
		refType: 'dispute',
		refId: disputeId,
		chargeId
	});
}

/**
 * Dispatches a Stripe event to the appropriate handler and records the event for deduplication.
 *
 * @param event - The Stripe event to process
 * @returns `true` if the event type is supported, `false` otherwise
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<boolean> {
	let handled: boolean;
	switch (event.type) {
		case 'checkout.session.completed':
		case 'checkout.session.async_payment_succeeded':
			await fulfillCheckout(event.data.object.id);
			handled = true;
			break;
		case 'checkout.session.async_payment_failed':
			// A delayed-notification method finally failed: reverse whatever the
			// session may have granted (idempotent — see reverseCharge).
			await reverseSessionGrant(event.data.object.id);
			handled = true;
			break;
		case 'payment_intent.succeeded':
			await fulfillAutoTopup(event.data.object.id);
			handled = true;
			break;
		case 'payment_intent.payment_failed':
			// Handled by the auto top-up module (needs the org's state columns).
			await handleAutoTopupFailure(event.data.object.id);
			handled = true;
			break;
		case 'charge.refunded':
			// Stripe's charge.refunded fires for partial refunds too, so
			// reverseCharge verifies the charge is FULLY refunded (amounts
			// compared) before reversing the grant. Partial refunds
			// (refund.created/refund.updated) are intentionally unhandled, and
			// reversing after the credits are spent can leave a negative balance
			// — both documented v1 limitations (docs/stripe-checkout-webhooks.md §7).
			await reverseCharge(event.data.object.id, 'refund');
			handled = true;
			break;
		case 'charge.dispute.created':
			await reverseDispute(event.data.object.id);
			handled = true;
			break;
		case 'charge.dispute.closed':
			await restoreWonDispute(event.data.object.id);
			handled = true;
			break;
		case 'charge.dispute.funds_withdrawn':
		case 'charge.dispute.funds_reinstated':
			console.error(`stripe: dispute lifecycle event ${event.type} for ${event.data.object.id} — funds_* events need manual review`);
			handled = true;
			break;
		default:
			console.error(`stripe: ignoring unhandled event type ${event.type}`);
			handled = false;
	}
	// Dedupe anchor for FUTURE deliveries. Recorded even for ignored types so
	// the receipt is the audit trail; ON CONFLICT DO NOTHING covers both the
	// event-id and (type, object) uniqueness anchors.
	await recordEvent(event);
	return handled;
}

/**
 * Reverses credits granted for a Checkout Session whose delayed payment failed.
 *
 * @param sessionId - The Stripe Checkout Session identifier
 * @returns `true` if a grant was reversed, `false` if the session lacks organization metadata or no matching grant exists
 */
async function reverseSessionGrant(sessionId: string): Promise<boolean> {
	const session = await getStripe().checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
	const paymentIntent = typeof session.payment_intent === 'string' ? null : session.payment_intent;
	const orgId = session.metadata?.org_id;
	if (!orgId) return false;
	const match = await findGrantForStripe(db, { paymentIntentId: paymentIntent?.id, chargeId: typeof paymentIntent?.latest_charge === 'string' ? paymentIntent.latest_charge : undefined });
	if (!match) {
		console.error(`stripe: async payment failed for ${sessionId} but no grant matched — nothing to reverse`);
		return false;
	}
	return applyLedgerDelta(db, {
		orgId: match.orgId,
		delta: -match.credits,
		reason: 'refund',
		refType: 'charge',
		refId: typeof paymentIntent?.latest_charge === 'string' ? paymentIntent.latest_charge : sessionId,
		chargeId: typeof paymentIntent?.latest_charge === 'string' ? paymentIntent.latest_charge : undefined,
		paymentIntentId: paymentIntent?.id
	});
}
