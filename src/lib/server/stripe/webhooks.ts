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
//  1. stripe_events dedupes the delivery by exact event_id; the
//     event_type/object_id index is observational only, not a dedupe key.
//  2. credit grants are anchored on UNIQUE(org_id, ref_type, ref_id) in the
//     ledger, so even a dedupe miss cannot double-credit.
// The inbox lease is claimed before side effects and marked complete only after
// successful handling; failed handlers release the lease for Stripe's retry.

import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type Stripe from 'stripe';

import { db } from '$lib/server/db';
import { organizations, creditTransactions, stripeEvents, stripeLifetimeEntitlements, stripeDisputeReversals } from '$lib/server/db/schema';
import { applyLedgerDelta, drainPendingReversals, findGrantForStripe, queuePendingReversal } from '$lib/server/billing/ledger';
import { grantAutoTopupCredits, handleAutoTopupFailure } from '$lib/server/billing/autotopup';
import { claimLifetimeSlot, grantSubscriptionPeriod, refundSubscriptionPeriod, disputeSubscriptionPeriod, releaseLifetimeForPayment, applySubscriptionSnapshot, revokeLifetimeForDispute, restoreLifetimeForDispute, restoreDisputedSubscriptionPeriod } from '$lib/server/billing/entitlements';
import { bundleById, type CreditBundle } from '$lib/server/stripe/bundles';
import { getStripe } from '$lib/server/stripe/client';

/**
 * Records a Stripe event when it has not already been recorded.
 *
 * @param event - The Stripe event to record
 * @returns `true` if the event was newly recorded, `false` if it was already recorded
 */
const EVENT_LEASE_MS = 5 * 60 * 1000;

function eventObjectIdentity(event: Stripe.Event): { objectId: string; objectType: string } {
	const object = event.data.object;
	if (!object || typeof object !== 'object') throw new Error(`Stripe event ${event.id} has no object id`);
	const record = object as unknown as { id?: unknown; object?: unknown };
	if (typeof record.id !== 'string' || record.id.length === 0) throw new Error(`Stripe event ${event.id} has no object id`);
	return { objectId: record.id, objectType: typeof record.object === 'string' ? record.object : 'unknown' };
}

async function claimEvent(event: Stripe.Event): Promise<boolean> {
	const now = new Date();
	const nowIso = now.toISOString();
	const identity = eventObjectIdentity(event);
	const inserted = await db
		.insert(stripeEvents)
		.values({
			eventId: event.id,
			eventType: event.type,
			objectId: identity.objectId,
			objectType: identity.objectType,
			processingStartedAt: nowIso,
			processingAttempts: 1
		})
		.onConflictDoNothing()
		.returning({ id: stripeEvents.id });
	if (inserted.length === 1) return true;
	const existing = await db.select({ processedAt: stripeEvents.processedAt, processingStartedAt: stripeEvents.processingStartedAt }).from(stripeEvents).where(eq(stripeEvents.eventId, event.id)).get();
	if (!existing) throw new Error(`Stripe event ${event.id} disappeared while claiming`);
	if (existing.processedAt) return false;
	const startedAt = existing.processingStartedAt ? Date.parse(existing.processingStartedAt) : 0;
	const stale = !Number.isFinite(startedAt) || now.getTime() - startedAt >= EVENT_LEASE_MS;
	if (!stale) throw new Error(`Stripe event ${event.id} is already being processed`);
	const attempts = (await db.select({ attempts: stripeEvents.processingAttempts }).from(stripeEvents).where(eq(stripeEvents.eventId, event.id)).get())?.attempts ?? 0;
	const reclaimed = await db
		.update(stripeEvents)
		.set({ processingStartedAt: nowIso, processingAttempts: attempts + 1 })
		.where(and(eq(stripeEvents.eventId, event.id), isNull(stripeEvents.processedAt), or(isNull(stripeEvents.processingStartedAt), lt(stripeEvents.processingStartedAt, new Date(now.getTime() - EVENT_LEASE_MS).toISOString()))))
		.returning({ id: stripeEvents.id });
	if (reclaimed.length === 1) return true;
	const afterRace = await db.select({ processedAt: stripeEvents.processedAt }).from(stripeEvents).where(eq(stripeEvents.eventId, event.id)).get();
	if (afterRace?.processedAt) return false;
	throw new Error(`Stripe event ${event.id} is already being processed`);
}

async function markEventProcessed(eventId: string): Promise<void> {
	await db.update(stripeEvents).set({ processedAt: new Date().toISOString(), processingStartedAt: null }).where(eq(stripeEvents.eventId, eventId));
}

async function releaseEventClaim(eventId: string): Promise<void> {
	await db.update(stripeEvents).set({ processingStartedAt: null }).where(and(eq(stripeEvents.eventId, eventId), isNull(stripeEvents.processedAt)));
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
	const product = session.metadata?.product;
	const bundleId = session.metadata?.bundle;
	if (!orgId) {
		console.error(`stripe: checkout session ${sessionId} has no org_id/bundle metadata — cannot credit`);
		return 'rejected';
	}
	if ((product && bundleId) || (!product && !bundleId) || (product && product !== 'hosted' && product !== 'lifetime')) {
		console.error(`stripe: checkout session ${sessionId} has invalid product metadata — cannot fulfill`);
		return 'rejected';
	}
	// Late-grant revalidation: the success page can fulfill an OLD paid
	// session at any time — potentially long after the 14-day pending-reversal
	// sweep dropped a queued reversal. Granting would hand credits back for
	// money that already left (fully refunded or disputed), so the charge's
	// CURRENT state is checked before the ledger mutation.
	if (rejectLateGrant(session, sessionId)) return 'rejected';

	const { paymentIntent, charge } = getPaymentIntentAndCharge(session);
	if (product === 'hosted' || product === 'lifetime') {
		if (product === 'hosted') {
			const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
			if (session.mode !== 'subscription' || !subscriptionId) {
				console.error(`stripe: hosted checkout ${sessionId} is not a subscription session`);
				return 'rejected';
			}
			const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
			const existing = await db.select({ stripeSubscriptionId: organizations.stripeSubscriptionId, stripeSubscriptionStatus: organizations.stripeSubscriptionStatus, stripeCustomerId: organizations.stripeCustomerId }).from(organizations).where(eq(organizations.id, orgId)).get();
			if (!existing) throw new Error(`org not found: ${orgId}`);
			const lifetime = await db.select({ id: stripeLifetimeEntitlements.id }).from(stripeLifetimeEntitlements).where(and(eq(stripeLifetimeEntitlements.orgId, orgId), eq(stripeLifetimeEntitlements.status, 'active'))).get();
			if (lifetime) {
				console.error(`stripe: hosted checkout ${sessionId} would overlap lifetime access for ${orgId}`);
				return 'rejected';
			}
			if (existing.stripeSubscriptionId && existing.stripeSubscriptionId !== subscriptionId && ['active', 'trialing', 'past_due', 'unpaid'].includes(existing.stripeSubscriptionStatus ?? '')) {
				console.error(`stripe: hosted checkout ${sessionId} would replace an active subscription for ${orgId}`);
				return 'rejected';
			}
			if (existing.stripeCustomerId && customerId && existing.stripeCustomerId !== customerId) {
				console.error(`stripe: hosted checkout ${sessionId} customer does not belong to org ${orgId}`);
				return 'rejected';
			}
			if (existing.stripeSubscriptionId === subscriptionId) return 'already';
			await db.update(organizations).set({ stripeSubscriptionId: subscriptionId, stripeCustomerId: customerId ?? existing.stripeCustomerId }).where(eq(organizations.id, orgId));
			return 'granted';
		}
		if (session.mode !== 'payment') {
			console.error(`stripe: lifetime checkout ${sessionId} is not a one-time payment session`);
			return 'rejected';
		}
		const existing = await db.select({ id: stripeLifetimeEntitlements.id }).from(stripeLifetimeEntitlements).where(eq(stripeLifetimeEntitlements.checkoutSessionId, sessionId)).get();
		if (existing) return 'already';
		const org = await db.select({ stripeSubscriptionId: organizations.stripeSubscriptionId, stripeSubscriptionStatus: organizations.stripeSubscriptionStatus }).from(organizations).where(eq(organizations.id, orgId)).get();
		if (!org) throw new Error(`org not found: ${orgId}`);
		if (org.stripeSubscriptionId && ['active', 'trialing', 'past_due', 'unpaid'].includes(org.stripeSubscriptionStatus ?? '')) {
			console.error(`stripe: lifetime checkout ${sessionId} would overlap hosted access for ${orgId}`);
			return 'rejected';
		}
		const activeLifetime = await db.select({ id: stripeLifetimeEntitlements.id }).from(stripeLifetimeEntitlements).where(and(eq(stripeLifetimeEntitlements.orgId, orgId), eq(stripeLifetimeEntitlements.status, 'active'))).get();
		if (activeLifetime) return 'already';
		const result = await claimLifetimeSlot({
			orgId,
			checkoutSessionId: sessionId,
			paymentIntentId: paymentIntent?.id,
			chargeId: typeof paymentIntent?.latest_charge === 'string' ? paymentIntent.latest_charge : charge?.id
		});
		return result.status === 'active' && result.slot > 0 ? 'granted' : 'rejected';
	}

	// An unknown bundle id is an operator config bug, not a transient failure:
	// acknowledge loudly and reject (the credits can never be granted — a
	// retry storm would only produce three days of 500s).
	if (!bundleId) return 'rejected';
	const bundle = loadBundle(bundleId, sessionId);
	if (!bundle) return 'rejected';

	// Narrow the expanded object once (chargeId prefers the expanded
	// object's id — it is the same id either way).
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
	// later auto top-up can charge it off-session. Runs even when the grant
	// was already applied (duplicate delivery) so a transient first-delivery
	// failure is retried instead of leaving the org with no top-up card.
	await savePaymentMethod(session, orgId, paymentIntent, charge);
	return applied ? 'granted' : 'already';
}

/** Narrows the expanded Checkout session to the payment_intent and its latest_charge (both stay a string-union). */
function getPaymentIntentAndCharge(session: Stripe.Checkout.Session): {
	paymentIntent: Stripe.PaymentIntent | null;
	charge: Stripe.Charge | null | undefined;
} {
	const paymentIntent = typeof session.payment_intent === 'string' ? null : session.payment_intent;
	const charge = paymentIntent && typeof paymentIntent.latest_charge !== 'string' ? paymentIntent.latest_charge : undefined;
	return { paymentIntent, charge };
}

/** True when the charge backing this session is disputed or fully refunded — a late grant must be refused. */
function rejectLateGrant(session: Stripe.Checkout.Session, sessionId: string): boolean {
	const { charge } = getPaymentIntentAndCharge(session);
	if (!charge) return false;
	const fullyRefunded =
		typeof charge.amount_refunded === 'number' &&
		typeof charge.amount === 'number' &&
		charge.amount_refunded >= charge.amount;
	if (charge.disputed || fullyRefunded) {
		console.error(
			`stripe: checkout session ${sessionId} charge ${charge.id} is ${charge.disputed ? 'disputed' : 'fully refunded'} — late grant refused`
		);
		return true;
	}
	return false;
}

/** Resolves the bundle id or returns null (unknown bundle — loud rejection). */
function loadBundle(bundleId: string, sessionId: string): CreditBundle | null {
	try {
		return bundleById(bundleId);
	} catch {
		console.error(`stripe: checkout session ${sessionId} references unknown bundle ${bundleId} — credits cannot be granted`);
		return null;
	}
}

/**
 * Saves the card used for this payment as the customer's default for future
 * auto top-ups. Every step is idempotent (attach, default-payment-method
 * update, org row update). A NEW saved card is a NEW billing instrument: the
 * consent evidence on file covered the OLD card, so auto top-up is disabled
 * whenever the default payment method CHANGES (fresh explicit owner action
 * needed; the consent row is kept for dispute defense). Failures THROW (after
 * a loud log) so the webhook answers 500 and Stripe redelivers — a swallowed
 * failure would permanently leave the org with no top-up card (codex 6141).
 */
async function savePaymentMethod(
	session: Stripe.Checkout.Session,
	orgId: string,
	paymentIntent: Stripe.PaymentIntent | null | undefined,
	charge: Stripe.Charge | null | undefined
): Promise<void> {
	const paymentMethod = paymentIntent?.payment_method;
	const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
	if (!paymentMethod || !customer) return;
	try {
		if (typeof paymentMethod !== 'string') {
			await getStripe().paymentMethods.attach(paymentMethod.id, { customer });
		}
		const paymentMethodId = typeof paymentMethod === 'string' ? paymentMethod : paymentMethod.id;
		await getStripe().customers.update(customer, { invoice_settings: { default_payment_method: paymentMethodId } });
		// Checked BEFORE the PM update below so the comparison sees the old card.
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
		const saved = await db
			.update(organizations)
			.set({ stripeCustomerId: customer, stripeDefaultPmId: paymentMethodId })
			.where(eq(organizations.id, orgId))
			.returning({ id: organizations.id });
		// The prior read proved the org existed; a zero-row update means it
		// was deleted in between. Fail loudly so the webhook retries instead
		// of acknowledging a grant whose payment method was never saved.
		if (saved.length === 0) throw new Error(`stripe: organization ${orgId} disappeared while saving a payment method`);
	} catch (error) {
		console.error(`stripe: could not save payment method for ${orgId}: ${error instanceof Error ? error.message : String(error)}`);
		throw new Error(`stripe: could not save payment method for org ${orgId} — webhook will retry`);
	}
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

async function recordDisputeReversal(input: { disputeId: string; chargeId: string; paymentIntentId?: string; status: string; source: string }): Promise<void> {
	await db.insert(stripeDisputeReversals).values(input).onConflictDoNothing({ target: stripeDisputeReversals.disputeId });
}

async function updateDisputeReversal(disputeId: string, values: { status?: string; source?: string }): Promise<void> {
	await db.update(stripeDisputeReversals).set(values).where(eq(stripeDisputeReversals.disputeId, disputeId));
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
export async function reverseCharge(chargeId: string, reason: 'refund' | 'dispute', disputeId?: string): Promise<boolean> {
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
	if (reason === 'dispute' && !disputeId) throw new Error(`dispute reversal for ${chargeId} is missing dispute id`);
	if (reason === 'dispute' && disputeId) await recordDisputeReversal({ disputeId, chargeId, paymentIntentId, status: 'pending', source: 'unknown' });
	if (reason === 'refund' || reason === 'dispute') {
		const lifetimeChanged = reason === 'refund' ? await releaseLifetimeForPayment({ paymentIntentId, chargeId }) : await revokeLifetimeForDispute({ paymentIntentId, chargeId });
		if (lifetimeChanged) {
			if (disputeId) await updateDisputeReversal(disputeId, { status: 'reversed', source: 'lifetime' });
			return true;
		}
		const periodChanged = reason === 'refund' ? await refundSubscriptionPeriod({ paymentIntentId, chargeId }) : await disputeSubscriptionPeriod({ paymentIntentId, chargeId });
		if (periodChanged) {
			if (disputeId) await updateDisputeReversal(disputeId, { status: 'reversed', source: 'subscription' });
			return true;
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
		await queuePendingReversal(chargeId, reason, disputeId);
		console.error(`stripe: ${reason} for ${chargeId} matched no credit grant — queued as pending reversal for when the grant lands`);
		return false;
	}
	// The grant may already have been reversed — each path's own anchor
	// (refType 'refund' or 'dispute', refId = charge id) makes the reversal
	// apply at most once per path.
	const applied = await applyLedgerDelta(db, {
		orgId: match.orgId,
		delta: -match.credits,
		reason,
		refType: reason === 'refund' ? 'refund' : 'dispute',
		refId: chargeId,
		chargeId,
		paymentIntentId
	});
	if (disputeId) await updateDisputeReversal(disputeId, { status: applied ? 'reversed' : 'ignored', source: 'credits' });
	return applied;
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
	if (dispute.status === 'won') return restoreWonDispute(disputeId);
	// The org is identified through the grant (a dispute on a charge that
	// never granted credits has no org to disable — logged by reverseCharge).
	const match = await findGrantForStripe(db, { chargeId });
	if (match) {
		await db
			.update(organizations)
			.set({ autoTopupEnabled: 0, autoTopupState: 'disabled' })
			.where(eq(organizations.id, match.orgId));
	}
	return reverseCharge(chargeId, 'dispute', disputeId);
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
	const reversal = await db.select().from(stripeDisputeReversals).where(eq(stripeDisputeReversals.disputeId, disputeId)).get();
	if (!reversal || reversal.status === 'ignored' || reversal.status === 'restored') return false;
	if (reversal.status === 'pending') {
		await db.update(stripeDisputeReversals).set({ status: 'won' }).where(eq(stripeDisputeReversals.disputeId, disputeId));
		return false;
	}
	const identifiers = { paymentIntentId: reversal.paymentIntentId ?? undefined, chargeId: reversal.chargeId };
	let restored = false;
	if (reversal.source === 'lifetime') restored = await restoreLifetimeForDispute(identifiers);
	else if (reversal.source === 'subscription') restored = await restoreDisputedSubscriptionPeriod(identifiers);
	else if (reversal.source === 'credits') {
		const match = await findGrantForStripe(db, identifiers);
		if (match) {
			const disputeReversal = await db.select({ id: creditTransactions.id }).from(creditTransactions).where(and(eq(creditTransactions.orgId, match.orgId), eq(creditTransactions.reason, 'dispute'), eq(creditTransactions.chargeId, reversal.chargeId))).get();
			if (disputeReversal) restored = await applyLedgerDelta(db, { orgId: match.orgId, delta: match.credits, reason: 'adjust', refType: 'dispute', refId: disputeId, chargeId: reversal.chargeId });
		}
	}
	if (!restored) return false;
	await db.update(stripeDisputeReversals).set({ status: 'restored', restoredAt: new Date().toISOString() }).where(eq(stripeDisputeReversals.disputeId, disputeId));
	return true;
}


type StripeRecord = Record<string, unknown>;

function asRecord(value: unknown): StripeRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Stripe returned a malformed object');
	return value as StripeRecord;
}

function stripeId(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) return value;
	if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id;
	return undefined;
}

function isoSeconds(value: unknown, field: string): string {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Stripe invoice field ${field} is invalid`);
	return new Date(value * 1000).toISOString();
}

async function findOrgForStripe(subscriptionId?: string, customerId?: string) {
	if (subscriptionId) {
		const bySubscription = await db.select().from(organizations).where(eq(organizations.stripeSubscriptionId, subscriptionId)).get();
		if (bySubscription) return bySubscription;
	}
	if (customerId) return db.select().from(organizations).where(eq(organizations.stripeCustomerId, customerId)).get();
	return undefined;
}

async function handleInvoicePaid(event: Stripe.Event): Promise<void> {
	const invoice = asRecord(event.data.object);
	const invoiceId = stripeId(invoice.id);
	const subscriptionId = stripeId(invoice.subscription);
	const customerId = stripeId(invoice.customer);
	if (!invoiceId || !subscriptionId) throw new Error(`invoice.paid ${event.id} is missing invoice or subscription id`);
	const org = await findOrgForStripe(subscriptionId, customerId);
	if (!org) {
		console.error(`stripe: invoice.paid ${invoiceId} has no mapped organization`);
		return;
	}
	const lines = asRecord(invoice.lines);
	const data = lines.data;
	if (!Array.isArray(data) || data.length === 0) throw new Error(`invoice.paid ${invoiceId} has no line items`);
	const line = asRecord(data[0]);
	const period = asRecord(line.period);
	const periodStart = isoSeconds(period.start, 'lines.data[0].period.start');
	const periodEnd = isoSeconds(period.end, 'lines.data[0].period.end');
	await grantSubscriptionPeriod({
		orgId: org.id,
		subscriptionId,
		invoiceId,
		paymentIntentId: stripeId(invoice.payment_intent),
		chargeId: stripeId(invoice.charge),
		periodKey: `${periodStart}/${periodEnd}`,
		periodStart,
		periodEnd,
		eventCreated: event.created,
		eventId: event.id
	});
}

async function handleInvoicePaymentFailed(event: Stripe.Event): Promise<void> {
	const invoice = asRecord(event.data.object);
	const subscriptionId = stripeId(invoice.subscription);
	const customerId = stripeId(invoice.customer);
	if (!subscriptionId && !customerId) throw new Error(`invoice.payment_failed ${event.id} is missing subscription and customer`);
	const org = await findOrgForStripe(subscriptionId, customerId);
	if (!org) {
		console.error(`stripe: invoice.payment_failed ${stripeId(invoice.id) ?? event.id} has no mapped organization`);
		return;
	}
	if (!org.stripeSubscriptionId || !org.stripeSubscriptionPeriodStart || !org.stripeSubscriptionPeriodEnd) {
		throw new Error(`invoice.payment_failed ${event.id} has no stored subscription period for ${org.id}`);
	}
	await applySubscriptionSnapshot({
		orgId: org.id,
		subscriptionId: org.stripeSubscriptionId,
		status: 'past_due',
		periodStart: org.stripeSubscriptionPeriodStart,
		periodEnd: org.stripeSubscriptionPeriodEnd,
		cancelAtPeriodEnd: org.stripeSubscriptionCancelAtPeriodEnd === 1,
		eventCreated: event.created,
		eventId: event.id
	});
}

async function handleSubscriptionEvent(event: Stripe.Event): Promise<void> {
	const subscription = asRecord(event.data.object);
	const subscriptionId = stripeId(subscription.id);
	const customerId = stripeId(subscription.customer);
	const status = typeof subscription.status === 'string' ? subscription.status : undefined;
	if (!subscriptionId || !status) throw new Error(`Stripe ${event.type} ${event.id} is missing subscription id or status`);
	const org = await findOrgForStripe(subscriptionId, customerId);
	if (!org) {
		console.error(`stripe: ${event.type} ${subscriptionId} has no mapped organization`);
		return;
	}
	const periodStart = subscription.current_period_start === undefined ? org.stripeSubscriptionPeriodStart : isoSeconds(subscription.current_period_start, 'current_period_start');
	const periodEnd = subscription.current_period_end === undefined ? org.stripeSubscriptionPeriodEnd : isoSeconds(subscription.current_period_end, 'current_period_end');
	if (!periodStart || !periodEnd) throw new Error(`Stripe ${event.type} ${event.id} has no subscription period`);
	if (typeof subscription.cancel_at_period_end !== 'boolean') throw new Error(`Stripe ${event.type} ${event.id} has invalid cancel_at_period_end`);
	await applySubscriptionSnapshot({
		orgId: org.id,
		subscriptionId,
		status,
		periodStart,
		periodEnd,
		cancelAtPeriodEnd: subscription.cancel_at_period_end,
		eventCreated: event.created,
		eventId: event.id
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
	// Claim a durable inbox lease before dispatch. Completed event IDs are
	// skipped; a competing live worker fails loudly so Stripe retries it.
	// Dedupe by EXACT EVENT ID only (codex review): Stripe re-emits events
	// for the same object — a charge.refunded first arrives partial, then
	// full — and each distinct delivery must reach its handler. The
	// (event_type, object_id) pair is deliberately NOT a dedupe anchor:
	// suppressing every later same-type event for an object would leave a
	// partial→full refund progression unreversed. Repeated processing is made
	// idempotent by the ledger's own UNIQUE anchors, so re-running a handler
	// can never double-apply.
	if (!(await claimEvent(event))) return true;
	let handled: boolean;
	try {
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
		case 'invoice.paid':
			await handleInvoicePaid(event);
			handled = true;
			break;
		case 'invoice.payment_failed':
			await handleInvoicePaymentFailed(event);
			handled = true;
			break;
		case 'customer.subscription.created':
		case 'customer.subscription.updated':
		case 'customer.subscription.deleted':
			await handleSubscriptionEvent(event);
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
		await markEventProcessed(event.id);
		return handled;
	} catch (error) {
		await releaseEventClaim(event.id);
		throw error;
	}
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
