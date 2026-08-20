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
import { applyLedgerDelta, drainPendingReversals, findGrantForStripe, queuePendingReversal } from '$lib/server/billing/ledger';
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
 *
 * The result is a three-way verdict, not a boolean (coderabbit): 'granted'
 * (this call applied the credits), 'already' (a previous delivery did — the
 * success page must still read success), and 'rejected' (the session cannot
 * or did not grant — never report success for it).
 *
 * @throws A card-persistence failure propagates (after a loud log) so the
 * webhook route answers 500 and Stripe redelivers — the idempotent retry
 * saves the card without double-granting (codex 6141). The grant itself is
 * already committed and never rolled back.
 */
export async function fulfillCheckout(sessionId: string): Promise<'granted' | 'already' | 'rejected'> {
	const session = await getStripe().checkout.sessions.retrieve(sessionId, {
		// latest_charge expanded so a LATE grant can revalidate the charge's
		// current refund/dispute state (codex review) without a second call.
		expand: ['payment_intent', 'payment_intent.latest_charge']
	});
	if (session.payment_status !== 'paid') return 'rejected';
	const orgId = session.metadata?.org_id;
	const bundleId = session.metadata?.bundle;
	if (!orgId || !bundleId) {
		console.error(`stripe: checkout session ${sessionId} has no org_id/bundle metadata — cannot credit`);
		return 'rejected';
	}
	// Late-grant revalidation: the success page can fulfill an OLD paid
	// session at any time — potentially long after the 14-day pending-reversal
	// sweep dropped a queued reversal. Granting would hand credits back for
	// money that already left (fully refunded or disputed), so the charge's
	// CURRENT state is checked before the ledger mutation. The webhook path
	// (fresh fulfillment) is unaffected: a refunded charge never grants here,
	// and the drain handles the ordering race for the reverse case.
	const paymentIntent = typeof session.payment_intent === 'string' ? null : session.payment_intent;
	const charge = paymentIntent && typeof paymentIntent.latest_charge !== 'string' ? paymentIntent.latest_charge : undefined;
	if (charge) {
		const fullyRefunded =
			typeof charge.amount_refunded === 'number' &&
			typeof charge.amount === 'number' &&
			charge.amount_refunded >= charge.amount;
		if (charge.disputed || fullyRefunded) {
			console.error(
				`stripe: checkout session ${sessionId} charge ${charge.id} is ${charge.disputed ? 'disputed' : 'fully refunded'} — late grant refused`
			);
			return 'rejected';
		}
	}
	// An unknown bundle id is an operator config bug, not a transient failure:
	// acknowledge loudly and reject (the credits can never be granted — a
	// retry storm would only produce three days of 500s). bundleById throws
	// for a missing id; catch and convert to the loud rejection.
	let bundle: CreditBundle;
	try {
		bundle = bundleById(bundleId);
	} catch {
		console.error(`stripe: checkout session ${sessionId} references unknown bundle ${bundleId} — credits cannot be granted`);
		return 'rejected';
	}
	// Narrow the expanded object: the type stays a string-union, so touch
	// nested fields only after the check. chargeId prefers the expanded
	// object's id (it is the same id either way).
	const chargeId = typeof paymentIntent?.latest_charge === 'string' ? paymentIntent.latest_charge : charge?.id;
	const applied = await applyLedgerDelta(db, {
		orgId,
		delta: creditsForBundle(bundle),
		reason: 'purchase',
		refType: 'checkout_session',
		refId: sessionId,
		paymentIntentId: paymentIntent?.id,
		chargeId
	});
	// A refund/dispute event may have arrived BEFORE this grant (Stripe does
	// not order deliveries): apply the queued reversal now, in the same
	// breath as the grant, so the customer never keeps credits for money that
	// already left (codex 6153). Runs only when THIS call granted — an
	// 'already' delivery drained on its own first run.
	if (applied && chargeId) {
		const drained = await drainPendingReversals(chargeId);
		if (drained > 0) console.error(`stripe: checkout grant ${sessionId} immediately drained ${drained} pending reversal(s) for ${chargeId}`);
	}
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
			// A NEW saved card is a NEW billing instrument: the consent
			// evidence on file covered the OLD card. Unscheduled off-session
			// charges must not move to a card the cardholder never authorized —
			// disable auto top-up whenever the default payment method CHANGES
			// (codex review). The consent evidence row is kept (the record that
			// authorization was once given must survive for dispute defense);
			// re-enabling is a fresh explicit owner action on the Usage page.
			// Checked BEFORE the PM update below so the comparison sees the old
			// card.
			const prior = await db
				.select({ autoTopupEnabled: organizations.autoTopupEnabled, stripeDefaultPmId: organizations.stripeDefaultPmId })
				.from(organizations)
				.where(eq(organizations.id, orgId))
				.get();
			// The grant step already verified the org exists, so a missing row
			// here is a concurrent-deletion bug: fail loudly instead of
			// acknowledging the event while updating zero rows.
			if (!prior) throw new Error(`stripe: organization ${orgId} is missing while saving a payment method`);
			if (prior.autoTopupEnabled === 1 && prior.stripeDefaultPmId && prior.stripeDefaultPmId !== paymentMethodId) {
				await db
					.update(organizations)
					.set({ autoTopupEnabled: 0, autoTopupState: 'disabled' })
					.where(eq(organizations.id, orgId));
				console.error(
					`stripe: saved payment method changed for org ${orgId} (${prior.stripeDefaultPmId} -> ${paymentMethodId}) — auto top-up DISABLED, fresh consent required`
				);
			}
			await db
				.update(organizations)
				.set({ stripeCustomerId: customer, stripeDefaultPmId: paymentMethodId })
				.where(eq(organizations.id, orgId));
		} catch (error) {
			// The credits are already granted, but a swallowed failure would
			// make the webhook answer 200 and Stripe would never redeliver —
			// the org would permanently have no top-up card. Throw (after the
			// loud log): the route 500s, Stripe retries, and the idempotent
			// retry saves the card without double-granting (codex 6141).
			console.error(`stripe: could not save payment method for ${orgId}: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error(`stripe: could not save payment method for org ${orgId} — webhook will retry`);
		}
	}
	return applied ? 'granted' : 'already';
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
		// No grant YET — Stripe does not guarantee delivery order, so the
		// charge.refunded/dispute.created can precede the checkout event that
		// granted the money. Queue the reversal durably: when the grant lands,
		// fulfillCheckout/fulfillAutoTopup drains it and the credits come back
		// (codex 6153). A charge that never grants leaves a stale row the cron
		// sweep drops after the webhook-retry horizon.
		await queuePendingReversal(chargeId, reason);
		console.error(`stripe: ${reason} for ${chargeId} matched no credit grant — queued as pending reversal for when the grant lands`);
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
 * Dispatches a Stripe event to the appropriate handler. The receipt gate
 * short-circuits duplicate deliveries BEFORE the handler; the receipt is
 * committed only after successful handling so Stripe's retry re-runs a
 * failed delivery.
 *
 * @param event - The Stripe event to process
 * @returns `true` if the event type is supported, `false` otherwise
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<boolean> {
	// Receipt gate BEFORE dispatch (coderabbit): an event already processed is
	// a duplicate delivery (same event id) or Stripe's two-Event-objects case
	// (same type+object, new id) — skip the handler entirely instead of
	// re-running Stripe calls. The receipt is committed only AFTER successful
	// handling: a thrown handler leaves no receipt, so the route's 500 makes
	// Stripe redeliver and the handler re-runs (all handlers are idempotent).
	// Dedupe by EXACT EVENT ID only (codex review): Stripe re-emits events
	// for the same object — a charge.refunded first arrives partial, then
	// full — and each distinct delivery must reach its handler. The
	// (event_type, object_id) pair is deliberately NOT a dedupe anchor:
	// suppressing every later same-type event for an object would leave a
	// partial→full refund progression unreversed. Repeated processing is made
	// idempotent by the ledger's own UNIQUE anchors, so re-running a handler
	// can never double-apply.
	const alreadyRecorded = await db
		.select({ id: stripeEvents.id })
		.from(stripeEvents)
		.where(eq(stripeEvents.eventId, event.id))
		.get();
	if (alreadyRecorded) return true;
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
