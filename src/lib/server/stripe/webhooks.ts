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

// Stripe webhook event handling. Every handler is idempotent:
//  1. stripe_events dedupes the delivery by exact event_id; the
//     event_type/object_id index is observational only, not a dedupe key.
//  2. credit grants are anchored on UNIQUE(org_id, ref_type, ref_id) in the
//     ledger, so even a dedupe miss cannot double-credit.
// The inbox lease is claimed before side effects and marked complete only after
// successful handling; failed handlers release the lease for Stripe's retry.

import { and, eq, isNull, lt, ne, or } from 'drizzle-orm';
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';

import { db } from '$lib/server/db';
import { organizations, creditTransactions, stripeEvents, stripeLifetimeEntitlements, stripeDisputeReversals } from '$lib/server/db/schema';
import { applyLedgerDelta, drainPendingReversals, findGrantForStripe, queuePendingReversal } from '$lib/server/billing/ledger';
import { grantAutoTopupCredits, handleAutoTopupFailure } from '$lib/server/billing/autotopup';
import { claimLifetimeSlot, grantSubscriptionPeriod, refundSubscriptionPeriod, disputeSubscriptionPeriod, releaseLifetimeForPayment, applySubscriptionSnapshot, isNewerEvent, revokeLifetimeForDispute, restoreLifetimeForDispute, restoreDisputedSubscriptionPeriod } from '$lib/server/billing/entitlements';
import { bundleById, type CreditBundle } from '$lib/server/stripe/bundles';
import { isActiveSubscriptionStatus } from '$lib/server/billing/plans';
import { markCheckoutAttemptFulfilled } from '$lib/server/billing/checkout';
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

export async function claimEvent(event: Stripe.Event): Promise<string | false> {
	const now = new Date();
	const nowIso = now.toISOString();
	const leaseToken = randomUUID();
	const identity = eventObjectIdentity(event);
	const inserted = await db
		.insert(stripeEvents)
		.values({
			eventId: event.id,
			eventType: event.type,
			objectId: identity.objectId,
			objectType: identity.objectType,
			processingStartedAt: nowIso,
			processingLeaseToken: leaseToken,
			processingAttempts: 1
		})
		.onConflictDoNothing()
		.returning({ id: stripeEvents.id });
	if (inserted.length === 1) return leaseToken;
	const existing = await db.select({ processedAt: stripeEvents.processedAt, processingStartedAt: stripeEvents.processingStartedAt }).from(stripeEvents).where(eq(stripeEvents.eventId, event.id)).get();
	if (!existing) throw new Error(`Stripe event ${event.id} disappeared while claiming`);
	if (existing.processedAt) return false;
	const startedAt = existing.processingStartedAt ? Date.parse(existing.processingStartedAt) : 0;
	const stale = !Number.isFinite(startedAt) || now.getTime() - startedAt >= EVENT_LEASE_MS;
	if (!stale) throw new Error(`Stripe event ${event.id} is already being processed`);
	const attempts = (await db.select({ attempts: stripeEvents.processingAttempts }).from(stripeEvents).where(eq(stripeEvents.eventId, event.id)).get())?.attempts ?? 0;
	const reclaimed = await db
		.update(stripeEvents)
		.set({ processingStartedAt: nowIso, processingLeaseToken: leaseToken, processingAttempts: attempts + 1 })
		.where(and(eq(stripeEvents.eventId, event.id), isNull(stripeEvents.processedAt), or(isNull(stripeEvents.processingStartedAt), lt(stripeEvents.processingStartedAt, new Date(now.getTime() - EVENT_LEASE_MS).toISOString()))))
		.returning({ id: stripeEvents.id });
	if (reclaimed.length === 1) return leaseToken;
	const afterRace = await db.select({ processedAt: stripeEvents.processedAt }).from(stripeEvents).where(eq(stripeEvents.eventId, event.id)).get();
	if (afterRace?.processedAt) return false;
	throw new Error(`Stripe event ${event.id} is already being processed`);
}

export async function markEventProcessed(eventId: string, leaseToken: string): Promise<boolean> {
	const updated = await db
		.update(stripeEvents)
		.set({ processedAt: new Date().toISOString(), processingStartedAt: null, processingLeaseToken: null })
		.where(and(eq(stripeEvents.eventId, eventId), eq(stripeEvents.processingLeaseToken, leaseToken), isNull(stripeEvents.processedAt)))
		.returning({ id: stripeEvents.id });
	if (updated.length === 1) return true;
	console.error(`stripe: lease for event ${eventId} was fenced before completion`);
	return false;
}

export async function releaseEventClaim(eventId: string, leaseToken: string): Promise<boolean> {
	const updated = await db
		.update(stripeEvents)
		.set({ processingStartedAt: null, processingLeaseToken: null })
		.where(and(eq(stripeEvents.eventId, eventId), eq(stripeEvents.processingLeaseToken, leaseToken), isNull(stripeEvents.processedAt)))
		.returning({ id: stripeEvents.id });
	return updated.length === 1;
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
			if (existing.stripeSubscriptionId && existing.stripeSubscriptionId !== subscriptionId && isActiveSubscriptionStatus(existing.stripeSubscriptionStatus)) {
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
		if (org.stripeSubscriptionId && isActiveSubscriptionStatus(org.stripeSubscriptionStatus)) {
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
		if (result.status === 'active' && result.slot > 0) return 'granted';
		console.error(`stripe: lifetime checkout ${sessionId} for org ${orgId} was PAID but claimed no slot (status ${result.status}, slot ${result.slot}) — manual refund required`);
		return 'rejected';
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

type DisputeReversalStatus = 'pending' | 'reversed' | 'ignored' | 'won' | 'restored';
type DisputeReversalSource = 'unknown' | 'lifetime' | 'subscription' | 'credits';

async function recordDisputeReversal(input: { disputeId: string; chargeId: string; paymentIntentId?: string; status: DisputeReversalStatus; source: DisputeReversalSource }): Promise<void> {
	await db.insert(stripeDisputeReversals).values(input).onConflictDoNothing({ target: stripeDisputeReversals.disputeId });
}

async function updateDisputeReversal(disputeId: string, values: { status?: DisputeReversalStatus; source?: DisputeReversalSource }): Promise<void> {
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
async function reverseEntitlements(chargeId: string, reason: 'refund' | 'dispute', paymentIntentId?: string, disputeId?: string): Promise<boolean> {
	const lifetimeChanged = reason === 'refund' ? await releaseLifetimeForPayment({ paymentIntentId, chargeId }) : await revokeLifetimeForDispute({ paymentIntentId, chargeId });
	if (lifetimeChanged) {
		if (disputeId) await updateDisputeReversal(disputeId, { status: 'reversed', source: 'lifetime' });
		return true;
	}
	const periodChanged = reason === 'refund' ? await refundSubscriptionPeriod({ paymentIntentId, chargeId }) : await disputeSubscriptionPeriod({ paymentIntentId, chargeId });
	if (periodChanged && disputeId) await updateDisputeReversal(disputeId, { status: 'reversed', source: 'subscription' });
	return periodChanged;
}

async function reverseCreditGrant(chargeId: string, reason: 'refund' | 'dispute', disputeId: string | undefined, paymentIntentId: string | undefined): Promise<boolean> {
	const match = await findGrantForStripe(db, { chargeId, paymentIntentId });
	if (!match) {
		await queuePendingReversal(chargeId, reason, disputeId);
		console.error(`stripe: ${reason} for ${chargeId} matched no credit grant — queued as pending reversal for when the grant lands`);
		return false;
	}
	const applied = await applyLedgerDelta(db, {
		orgId: match.orgId,
		delta: -match.credits,
		reason,
		refType: reason === 'refund' ? 'refund' : 'dispute',
		refId: chargeId,
		chargeId,
		paymentIntentId
	});
	if (disputeId) {
		let status: DisputeReversalStatus = applied ? 'reversed' : 'ignored';
		if (!applied) {
			const existingLedgerReversal = await db.select({ id: creditTransactions.id }).from(creditTransactions).where(and(eq(creditTransactions.orgId, match.orgId), eq(creditTransactions.reason, 'dispute'), eq(creditTransactions.chargeId, chargeId))).get();
			const otherDispute = await db.select({ id: stripeDisputeReversals.id }).from(stripeDisputeReversals).where(and(eq(stripeDisputeReversals.chargeId, chargeId), ne(stripeDisputeReversals.disputeId, disputeId), eq(stripeDisputeReversals.source, 'credits'), or(eq(stripeDisputeReversals.status, 'reversed'), eq(stripeDisputeReversals.status, 'restored')))).get();
			if (existingLedgerReversal && !otherDispute) status = 'reversed';
		}
		await updateDisputeReversal(disputeId, { status, source: 'credits' });
	}
	return applied;
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
	if (reason === 'refund' && (typeof charge.amount_refunded !== 'number' || typeof charge.amount !== 'number' || charge.amount_refunded < charge.amount)) {
		console.error(`stripe: refund for ${chargeId} is not a full refund (refunded ${charge.amount_refunded ?? 'unknown'} of ${charge.amount ?? 'unknown'}) — credits kept (v1 reverses only full refunds)`);
		return false;
	}
	if (reason === 'dispute' && !disputeId) throw new Error(`dispute reversal for ${chargeId} is missing dispute id`);
	if (disputeId) await recordDisputeReversal({ disputeId, chargeId, paymentIntentId, status: 'pending', source: 'unknown' });
	if (await reverseEntitlements(chargeId, reason, paymentIntentId, disputeId)) return true;
	return reverseCreditGrant(chargeId, reason, disputeId, paymentIntentId);
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
const MALFORMED_STRIPE_OBJECT_ERROR = 'Stripe returned a malformed object';
const INVOICE_LINE_REQUIRED_ERROR = 'Stripe invoice has no matching non-proration subscription line';
const INVOICE_PAYMENT_REQUIRED_ERROR = 'Stripe invoice has no usable payment reference';

function asRecord(value: unknown): StripeRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(MALFORMED_STRIPE_OBJECT_ERROR);
	return value as StripeRecord;
}

function optionalRecord(value: unknown): StripeRecord | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as StripeRecord) : undefined;
}

function stripeId(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) return value;
	if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id;
	return undefined;
}

function invoiceSubscriptionId(invoice: StripeRecord): string | undefined {
	const legacy = stripeId(invoice.subscription);
	if (legacy) return legacy;
	const parent = invoice.parent;
	if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return undefined;
	const parentRecord = parent as StripeRecord;
	if (parentRecord.type !== 'subscription_details') return undefined;
	const details = parentRecord.subscription_details;
	if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
	return stripeId((details as StripeRecord).subscription);
}

function subscriptionPeriod(subscription: StripeRecord, eventId: string): { periodStart: string; periodEnd: string } {
	let start = subscription.current_period_start;
	let end = subscription.current_period_end;
	if (start === undefined || end === undefined) {
		const items = asRecord(subscription.items);
		const data = items.data;
		if (!Array.isArray(data) || data.length === 0) throw new Error(`Stripe subscription event ${eventId} has no subscription items`);
		const item = asRecord(data[0]);
		start ??= item.current_period_start;
		end ??= item.current_period_end;
	}
	return { periodStart: isoSeconds(start, 'current_period_start'), periodEnd: isoSeconds(end, 'current_period_end') };
}

function isoSeconds(value: unknown, field: string): string {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Stripe invoice field ${field} is invalid`);
	return new Date(value * 1000).toISOString();
}

function invoiceLineSubscriptionId(line: StripeRecord): string | undefined {
	const direct = stripeId(line.subscription);
	if (direct) return direct;
	const parent = optionalRecord(line.parent);
	if (parent?.type !== 'subscription_item_details') return undefined;
	return stripeId(optionalRecord(parent.subscription_item_details)?.subscription);
}

function invoiceLineIsProration(line: StripeRecord): boolean {
	if (line.proration === true) return true;
	const parent = optionalRecord(line.parent);
	return optionalRecord(parent?.subscription_item_details)?.proration === true;
}

function invoicePeriod(invoice: StripeRecord, subscriptionId: string): { periodStart: string; periodEnd: string } {
	const lines = asRecord(invoice.lines);
	const data = lines.data;
	if (!Array.isArray(data) || data.length === 0) throw new Error('Stripe invoice has no line items');
	const line = data
		.map(optionalRecord)
		.find((item) => item && !invoiceLineIsProration(item) && invoiceLineSubscriptionId(item) === subscriptionId);
	if (!line) throw new Error(INVOICE_LINE_REQUIRED_ERROR);
	const period = asRecord(line.period);
	return { periodStart: isoSeconds(period.start, 'subscription line period.start'), periodEnd: isoSeconds(period.end, 'subscription line period.end') };
}

function invoicePaymentReferences(invoice: StripeRecord): { paymentIntentId?: string; chargeId?: string } {
	const payments = invoice.payments === undefined || invoice.payments === null ? undefined : asRecord(invoice.payments);
	const data = payments?.data;
	if (payments && !Array.isArray(data)) throw new Error('Stripe invoice payments is malformed');
	if (Array.isArray(data)) {
		for (const item of data) {
			const payment = optionalRecord(optionalRecord(item)?.payment);
			const paymentIntentId = stripeId(payment?.payment_intent);
			const chargeId = stripeId(payment?.charge);
			if (paymentIntentId || chargeId) return { paymentIntentId, chargeId };
		}
	}
	const legacy = { paymentIntentId: stripeId(invoice.payment_intent), chargeId: stripeId(invoice.charge) };
	if (legacy.paymentIntentId || legacy.chargeId) return legacy;
	throw new Error(INVOICE_PAYMENT_REQUIRED_ERROR);
}

function storedSubscriptionPeriod(org: Awaited<ReturnType<typeof findOrgForStripe>>, eventId: string): { subscriptionId: string; periodStart: string; periodEnd: string } {
	if (!org?.stripeSubscriptionId || !org.stripeSubscriptionPeriodStart || !org.stripeSubscriptionPeriodEnd) throw new Error(`Stripe invoice.payment_failed ${eventId} has no stored subscription period`);
	return { subscriptionId: org.stripeSubscriptionId, periodStart: org.stripeSubscriptionPeriodStart, periodEnd: org.stripeSubscriptionPeriodEnd };
}

async function findOrgForStripe(subscriptionId?: string, customerId?: string) {
	if (subscriptionId) {
		const bySubscription = await db.select().from(organizations).where(eq(organizations.stripeSubscriptionId, subscriptionId)).get();
		if (bySubscription) return bySubscription;
	}
	if (customerId) return db.select().from(organizations).where(eq(organizations.stripeCustomerId, customerId)).get();
	return undefined;
}

/**
 * Card-management sync for the Stripe customer portal: removals happen
 * off-app, so the org's saved top-up card pointer must never go stale. The
 * removed card being the org's DEFAULT clears the pointer and pauses auto
 * top-up — the consent evidence covered the old card (same rule as
 * savePaymentMethod's card-change branch); any other wallet card is a no-op.
 * The lookup keys on the PM id, never the event's customer: Stripe fires
 * `payment_method.detached` AFTER detachment, so `customer` is already null
 * on the delivered object (codex P1).
 */
async function handlePaymentMethodDetached(paymentMethod: Stripe.PaymentMethod): Promise<void> {
	const org = await db.select().from(organizations).where(eq(organizations.stripeDefaultPmId, paymentMethod.id)).get();
	if (!org) {
		// Some other wallet card, or a customer erased at Stripe by account
		// deletion: nothing to sync, and redelivery can never fix it — so
		// acknowledge (in the server log) instead of throwing into Stripe's
		// multi-day retry loop.
		console.info(`stripe: payment_method.detached ${paymentMethod.id} is no organization's top-up card — nothing to sync`);
		return;
	}
	// Compare-and-set: between the read above and this write, a concurrent
	// customer.updated can store a REPLACEMENT card — an update keyed only on
	// the org id would clear that valid new card (codex P1). Zero rows = the
	// pointer already moved; acknowledge, never retry.
	const res = await db
		.update(organizations)
		.set({ stripeDefaultPmId: null, autoTopupEnabled: 0, autoTopupState: 'disabled' })
		.where(and(eq(organizations.id, org.id), eq(organizations.stripeDefaultPmId, paymentMethod.id)));
	if (res.rowsAffected === 0) {
		console.info(`stripe: payment_method.detached ${paymentMethod.id} lost the apply race for org ${org.id} — the pointer already moved to a newer card`);
		return;
	}
	console.error(`stripe: the top-up card ${paymentMethod.id} was removed for org ${org.id} — auto top-up DISABLED; save a new card and re-enable`);
}

/**
 * Customer-portal default-card sync: a NEW default payment method is a new
 * billing instrument the on-file consent never covered, so the pointer
 * resyncs and auto top-up pauses for fresh consent. Events without the
 * default_payment_method KEY (the account-deletion e-mail scrub, name
 * changes) are not card changes and leave the org untouched; an EXPLICIT
 * null default is a real removal and mirrors as a cleared pointer (cubic P1).
 * Stripe does not guarantee webhook ordering, so snapshots apply only in
 * envelope order — the persisted cursor (`stripe_customer_last_event_*`)
 * rejects an older event arriving late instead of letting it resurrect a
 * previous card (same guard as applySubscriptionSnapshot; coderabbit MAJOR).
 */
async function handleCustomerUpdated(customer: Stripe.Customer, eventCreated: number | undefined, eventId: string): Promise<void> {
	const org = await findOrgForStripe(undefined, customer.id);
	if (!org) {
		console.info(`stripe: customer.updated for untracked customer ${customer.id} — nothing to sync`);
		return;
	}
	const settings = customer.invoice_settings;
	if (!settings || !('default_payment_method' in settings)) return;
	if (typeof eventCreated !== 'number') {
		throw new Error(`customer.updated ${eventId} is missing its envelope created timestamp`);
	}
	if (!isNewerEvent(org.stripeCustomerLastEventCreated, org.stripeCustomerLastEventId, eventCreated, eventId)) {
		console.error(`stripe: ignoring stale customer.updated ${eventId} for org ${org.id} (created ${eventCreated}, last applied ${org.stripeCustomerLastEventCreated ?? 'none'})`);
		return;
	}
	const incoming = settings.default_payment_method;
	// I2: a present key must carry a usable value — null (cleared), a
	// non-empty string id, or an expanded object with a non-empty string id.
	// Anything else ({ id: 123 }, '', {}) is a failed API call: throw so
	// Stripe redelivers rather than freezing garbage into the org row (codex P2).
	let incomingId: string | null;
	if (incoming === null) {
		incomingId = null;
	} else if (typeof incoming === 'string' && incoming.length > 0) {
		incomingId = incoming;
	} else if (typeof incoming === 'object' && typeof incoming.id === 'string' && incoming.id.length > 0) {
		incomingId = incoming.id;
	} else {
		throw new Error(`customer.updated ${eventId} carries a malformed default_payment_method`);
	}
	// Compare-and-set in the UPDATE itself: two deliveries hold independent
	// inbox leases and can both pass the read-time guard, so the write must
	// re-check the cursor. Zero rows = a newer-or-equal snapshot landed
	// meanwhile — acknowledge (a redelivery can never fix a lost race).
	const cursorStillOlder = or(
		isNull(organizations.stripeCustomerLastEventCreated),
		lt(organizations.stripeCustomerLastEventCreated, eventCreated),
		and(
			eq(organizations.stripeCustomerLastEventCreated, eventCreated),
			or(isNull(organizations.stripeCustomerLastEventId), lt(organizations.stripeCustomerLastEventId, eventId))
		)
	);
	const applyIfCurrent = async (set: Partial<typeof organizations.$inferInsert>): Promise<boolean> => {
		const res = await db.update(organizations).set(set).where(and(eq(organizations.id, org.id), cursorStillOlder));
		if (res.rowsAffected === 0) {
			console.info(`stripe: customer.updated ${eventId} lost the apply race for org ${org.id} — a newer-or-equal snapshot already landed`);
			return false;
		}
		return true;
	};
	if (incomingId === org.stripeDefaultPmId) {
		// No card change, but the cursor must still advance — otherwise a
		// stale snapshot arriving later could resurrect the previous card.
		await applyIfCurrent({ stripeCustomerLastEventCreated: eventCreated, stripeCustomerLastEventId: eventId });
		return;
	}
	const applied = await applyIfCurrent({
		stripeDefaultPmId: incomingId,
		stripeCustomerLastEventCreated: eventCreated,
		stripeCustomerLastEventId: eventId,
		...(org.autoTopupEnabled === 1 ? { autoTopupEnabled: 0, autoTopupState: 'disabled' } : {})
	});
	if (!applied) return;
	const change = incomingId ? `${org.stripeDefaultPmId} -> ${incomingId}` : `${org.stripeDefaultPmId} -> cleared`;
	if (org.autoTopupEnabled === 1) {
		console.error(`stripe: default card changed for org ${org.id} (${change}) — auto top-up DISABLED, fresh consent required`);
	} else {
		console.info(`stripe: default card changed for org ${org.id} (${change})`);
	}
}

function isSupersededSubscription(org: Awaited<ReturnType<typeof findOrgForStripe>>, subscriptionId: string, eventType: string): boolean {
	if (!org?.stripeSubscriptionId || org.stripeSubscriptionId === subscriptionId) return false;
	console.error(`stripe: ignoring stale ${eventType} for superseded subscription ${subscriptionId}; current subscription is ${org.stripeSubscriptionId}`);
	return true;
}

async function handleInvoicePaid(event: Stripe.Event): Promise<void> {
	const invoice = asRecord(event.data.object);
	const invoiceId = stripeId(invoice.id);
	const subscriptionId = invoiceSubscriptionId(invoice);
	const customerId = stripeId(invoice.customer);
	if (!invoiceId || !subscriptionId) throw new Error(`invoice.paid ${event.id} is missing invoice or subscription id`);
	const org = await findOrgForStripe(subscriptionId, customerId);
	if (!org) {
		console.error(`stripe: invoice.paid ${invoiceId} has no mapped organization`);
		return;
	}
	if (isSupersededSubscription(org, subscriptionId, 'invoice.paid')) return;
	const { periodStart, periodEnd } = invoicePeriod(invoice, subscriptionId);
	const payment = invoicePaymentReferences(invoice);
	await grantSubscriptionPeriod({ orgId: org.id, subscriptionId, invoiceId, ...payment, periodKey: `${periodStart}/${periodEnd}`, periodStart, periodEnd, eventCreated: event.created, eventId: event.id });
}

async function handleInvoicePaymentFailed(event: Stripe.Event): Promise<void> {
	const invoice = asRecord(event.data.object);
	const subscriptionId = invoiceSubscriptionId(invoice);
	const customerId = stripeId(invoice.customer);
	if (!subscriptionId && !customerId) throw new Error(`invoice.payment_failed ${event.id} is missing subscription and customer`);
	const org = await findOrgForStripe(subscriptionId, customerId);
	if (!org) {
		console.error(`stripe: invoice.payment_failed ${stripeId(invoice.id) ?? event.id} has no mapped organization`);
		return;
	}
	if (subscriptionId && isSupersededSubscription(org, subscriptionId, 'invoice.payment_failed')) return;
	const period = org?.stripeSubscriptionPeriodStart && org.stripeSubscriptionPeriodEnd
		? storedSubscriptionPeriod(org, event.id)
		: subscriptionId
			? { subscriptionId, ...invoicePeriod(invoice, subscriptionId) }
			: (() => { throw new Error(`Stripe invoice.payment_failed ${event.id} has no subscription period`); })();
	await applySubscriptionSnapshot({ orgId: org.id, status: 'past_due', ...period, cancelAtPeriodEnd: org.stripeSubscriptionCancelAtPeriodEnd === 1, eventCreated: event.created, eventId: event.id });
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
	const { periodStart, periodEnd } = subscriptionPeriod(subscription, event.id);
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
	const leaseToken = await claimEvent(event);
	if (!leaseToken) return true;
	let handled: boolean;
	try {
		switch (event.type) {
		case 'checkout.session.completed':
		case 'checkout.session.async_payment_succeeded': {
			const result = await fulfillCheckout(event.data.object.id);
			if (result === 'granted' || result === 'already') await markCheckoutAttemptFulfilled(event.data.object.id);
			handled = true;
			break;
		}
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
		case 'payment_method.detached':
			await handlePaymentMethodDetached(event.data.object);
			handled = true;
			break;
		case 'customer.updated':
			await handleCustomerUpdated(event.data.object, event.created, event.id);
			handled = true;
			break;
			default:
				console.error(`stripe: ignoring unhandled event type ${event.type}`);
				handled = false;
		}
		await markEventProcessed(event.id, leaseToken);
		return handled;
	} catch (error) {
		await releaseEventClaim(event.id, leaseToken);
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
