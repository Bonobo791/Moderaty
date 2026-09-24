// Stripe webhook event handling. Every handler is idempotent:
//  1. stripe_events dedupes the delivery by exact event_id; the
//     event_type/object_id index is observational only, not a dedupe key.
//  2. credit grants are anchored on UNIQUE(org_id, ref_type, ref_id) in the
//     ledger, so even a dedupe miss cannot double-credit.
// The inbox lease is claimed before side effects and marked complete only after
// successful handling; failed handlers release the lease for Stripe's retry.

import { and, eq, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';

import { db } from '$lib/server/db';
import { organizations, creditTransactions, stripeEvents, stripeLifetimeEntitlements, stripeDisputeReversals, stripeCheckoutAttempts, stripeSubscriptionPeriods } from '$lib/server/db/schema';
import { applyLedgerDelta, drainPendingReversals, findGrantForStripe, queuePendingReversal, UNMETERED_CREDIT_GRANT_ERROR } from '$lib/server/billing/ledger';
import { grantAutoTopupCredits, handleAutoTopupFailure } from '$lib/server/billing/autotopup';
import { claimLifetimeSlot, grantSubscriptionPeriod, refundSubscriptionPeriod, disputeSubscriptionPeriod, releaseLifetimeForPayment, applySubscriptionSnapshot, revokeLifetimeForDispute, restoreLifetimeForDispute, restoreDisputedSubscriptionPeriod, stripeIdentifierPredicate, LIFETIME_SOLD_OUT_ERROR } from '$lib/server/billing/entitlements';
import { bundleById, type CreditBundle } from '$lib/server/stripe/bundles';
import { isActiveSubscriptionStatus } from '$lib/server/billing/plans';
import { markCheckoutAttemptFulfilled, TEST_CHECKOUT_PRODUCT } from '$lib/server/billing/checkout';
import { getStripe } from '$lib/server/stripe/client';
import { refundUngrantablePayment } from '$lib/server/stripe/refunds';

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
 * The result is a verdict, not a boolean (coderabbit): 'granted' (this
 * call applied the credits/entitlement), 'already' (a previous delivery
 * did — the success page must still read success), 'refunded' (the session
 * was paid but ungrantable and the payment was refunded or queued for one
 * — the buyer sees that, not a generic failure), and 'rejected' (the
 * session cannot or did not grant — never report success for it).
 *
 * @throws A card-persistence failure propagates (after a loud log) so the
 * webhook route answers 500 and Stripe redelivers — the idempotent retry
 * saves the card without double-granting (codex 6141). The grant itself is
 * already committed and never rolled back. A refund failure also
 * propagates — no ACK for a paid customer we could not refund (review).
 */
export async function fulfillCheckout(sessionId: string): Promise<'granted' | 'already' | 'rejected' | 'refunded'> {
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
	if ((product && bundleId) || (!product && !bundleId) || (product && product !== 'hosted' && product !== 'lifetime' && product !== TEST_CHECKOUT_PRODUCT)) {
		console.error(`stripe: checkout session ${sessionId} has invalid product metadata — cannot fulfill`);
		return 'rejected';
	}
	// Late-grant revalidation: the success page can fulfill an OLD paid
	// session at any time — potentially long after the 14-day pending-reversal
	// sweep dropped a queued reversal. Granting would hand credits back for
	// money that already left (fully refunded or disputed), so the charge's
	// CURRENT state is checked before the ledger mutation.
	const lateVerdict = lateGrantVerdict(session, sessionId);
	if (lateVerdict) return lateVerdict;

	const { paymentIntent, charge } = getPaymentIntentAndCharge(session);
	if (product === 'hosted') return fulfillHostedCheckout(session, sessionId, orgId);
	if (product === 'lifetime') return fulfillLifetimeCheckout(session, sessionId, orgId, paymentIntent, charge);
	if (product === TEST_CHECKOUT_PRODUCT) return fulfillTestCheckout(session, sessionId, orgId, paymentIntent, charge);
	// An unknown bundle id is an operator config bug, not a transient failure:
	// acknowledge loudly and reject (the credits can never be granted — a
	// retry storm would only produce three days of 500s).
	if (!bundleId) return 'rejected';
	return fulfillBundleCheckout(session, sessionId, orgId, bundleId, paymentIntent, charge);
}

type CheckoutVerdict = 'granted' | 'already' | 'rejected' | 'refunded';

/**
 * Hosted checkout fulfillment: one live subscription per org, ever — the
 * org row is claimed CONDITIONALLY so a concurrent fulfillment losing the
 * race tears down and refunds its own duplicate instead of orphaning a
 * billing subscription (codeant P1).
 */
async function fulfillHostedCheckout(session: Stripe.Checkout.Session, sessionId: string, orgId: string): Promise<CheckoutVerdict> {
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
		// A PAID hosted checkout overlapping lifetime can never grant — but a
		// bare 'rejected' ACKs the delivery while the freshly minted
		// subscription keeps billing forever (coderabbit CRITICAL). It gets
		// the standard duplicate teardown: cancel at Stripe + refund every
		// paid invoice.
		console.error(`stripe: hosted checkout ${sessionId} would overlap lifetime access for ${orgId} — tearing down duplicate ${subscriptionId}`);
		await teardownDuplicateSubscription(subscriptionId, orgId, { checkoutSessionId: sessionId, paymentExpected: true });
		return 'refunded';
	}
	// One live subscription per org. The stored status is only a cache —
	// it is null until a subscription webhook lands and stale whenever
	// deliveries fail — so exclusivity is decided by the LIVE Stripe
	// status of the stored subscription. A live one means this paid
	// checkout minted a duplicate: cancel it and refund its first
	// invoice instead of keeping the money for a sub we never honor.
	if (existing.stripeSubscriptionId && existing.stripeSubscriptionId !== subscriptionId) {
		const liveStatus = await liveSubscriptionStatus(existing.stripeSubscriptionId);
		if (subscriptionStatusMeaning(existing.stripeSubscriptionId, liveStatus) === 'live') {
			console.error(`stripe: hosted checkout ${sessionId} for org ${orgId} would overlap live subscription ${existing.stripeSubscriptionId} (${liveStatus}) — tearing down duplicate ${subscriptionId}`);
			await teardownDuplicateSubscription(subscriptionId, orgId, { checkoutSessionId: sessionId, paymentExpected: true });
			return 'refunded';
		}
		console.info(`stripe: stored subscription ${existing.stripeSubscriptionId} for org ${orgId} is ${liveStatus} — checkout ${sessionId} replaces it`);
	}
	if (existing.stripeCustomerId && customerId && existing.stripeCustomerId !== customerId) {
		console.error(`stripe: hosted checkout ${sessionId} customer does not belong to org ${orgId}`);
		return 'rejected';
	}
	if (existing.stripeSubscriptionId === subscriptionId) return 'already';
	// Claim the org row CONDITIONALLY: a concurrent fulfillment can
	// commit a different subscription between the read above and this
	// write, and an unconditional update would overwrite the winner —
	// orphaning a live, billing subscription the org row no longer
	// names (codeant P1). Zero rows back means we lost the race: this
	// session's freshly minted subscription is the duplicate, so tear
	// it down and refund its first payment like any other duplicate.
	const claimed = await db.update(organizations).set({ stripeSubscriptionId: subscriptionId, stripeCustomerId: customerId ?? existing.stripeCustomerId }).where(and(eq(organizations.id, orgId), or(
		eq(organizations.stripeSubscriptionId, subscriptionId),
		existing.stripeSubscriptionId ? eq(organizations.stripeSubscriptionId, existing.stripeSubscriptionId) : isNull(organizations.stripeSubscriptionId)
	))).returning({ id: organizations.id });
	if (!claimed[0]) {
		console.error(`stripe: hosted checkout ${sessionId} for org ${orgId} lost the subscription claim to a concurrent fulfillment — tearing down duplicate ${subscriptionId}`);
		await teardownDuplicateSubscription(subscriptionId, orgId, { checkoutSessionId: sessionId, paymentExpected: true });
		return 'refunded';
	}
	// Subscription Checkout stores the paid card on the SUBSCRIPTION's
	// default_payment_method (customer.invoice_settings stays unset), so
	// the pointer is synced eagerly here — waiting on the
	// customer.subscription.created event would leave "no card saved"
	// until it lands, and fulfillment must not fail if this sync does.
	try {
		const liveSubscription = await getStripe().subscriptions.retrieve(subscriptionId, { expand: ['default_payment_method'] });
		const pmId = subscriptionDefaultPmId(asRecord(liveSubscription), `checkout ${sessionId}`);
		if (pmId) await applySubscriptionDefaultPm(orgId, pmId);
	} catch (cause) {
		console.error(`stripe: subscription card sync during fulfillment of ${sessionId} failed for org ${orgId} — customer.subscription events must deliver it`, cause);
	}
	return 'granted';
}

/**
 * Lifetime checkout fulfillment: a live-and-billing hosted subscription
 * blocks the grant (refunded like every ungrantable payment); a scheduled
 * wind-down does not — that is the supported cancel→lifetime path. The
 * verdict comes from the LIVE subscription unconditionally; the stored
 * status is a cache that goes stale in both directions (codeant P1).
 */
async function fulfillLifetimeCheckout(session: Stripe.Checkout.Session, sessionId: string, orgId: string, paymentIntent: Stripe.PaymentIntent | null, charge: Stripe.Charge | null | undefined): Promise<CheckoutVerdict> {
	if (session.mode !== 'payment') {
		console.error(`stripe: lifetime checkout ${sessionId} is not a one-time payment session`);
		return 'rejected';
	}
	const existing = await db.select({ id: stripeLifetimeEntitlements.id }).from(stripeLifetimeEntitlements).where(eq(stripeLifetimeEntitlements.checkoutSessionId, sessionId)).get();
	if (existing) return 'already';
	const org = await db.select({ stripeSubscriptionId: organizations.stripeSubscriptionId, stripeSubscriptionStatus: organizations.stripeSubscriptionStatus }).from(organizations).where(eq(organizations.id, orgId)).get();
	if (!org) throw new Error(`org not found: ${orgId}`);
	if (org.stripeSubscriptionId && (await liveHostedBlocksLifetime(org.stripeSubscriptionId, sessionId))) {
		console.error(`stripe: lifetime checkout ${sessionId} would overlap hosted access for ${orgId} — the live subscription is not scheduled to end`);
		await refundUngrantableCheckout(sessionId, orgId, paymentIntent, charge, 'the org has a live hosted subscription that is not scheduled to end');
		return 'refunded';
	}
	const activeLifetime = await db.select({ id: stripeLifetimeEntitlements.id, checkoutSessionId: stripeLifetimeEntitlements.checkoutSessionId }).from(stripeLifetimeEntitlements).where(and(eq(stripeLifetimeEntitlements.orgId, orgId), eq(stripeLifetimeEntitlements.status, 'active'))).get();
	// The winner may be THIS session: a concurrent duplicate delivery
	// (success redirect + webhook) committed between the session-scoped
	// read above and this one — its own claim is 'already', never a
	// refund of the payment that just won (codex P1).
	if (activeLifetime?.checkoutSessionId === sessionId) return 'already';
	// A second lifetime checkout for an org that already has one is paid
	// but can grant nothing — refund it like a slotless checkout rather
	// than reporting 'already' success while keeping the money (review).
	if (activeLifetime) {
		await refundUngrantableCheckout(sessionId, orgId, paymentIntent, charge, 'the org already has an active lifetime plan');
		return 'refunded';
	}
	let result: Awaited<ReturnType<typeof claimLifetimeSlot>>;
	try {
		result = await claimLifetimeSlot({
			orgId,
			checkoutSessionId: sessionId,
			paymentIntentId: paymentIntent?.id,
			chargeId: typeof paymentIntent?.latest_charge === 'string' ? paymentIntent.latest_charge : charge?.id
		});
	} catch (error) {
		if (!(error instanceof Error && error.message === LIFETIME_SOLD_OUT_ERROR)) {
			// A concurrent same-org claim loses on the unique active-org
			// index; the aborted tx's snapshot could not see the winner, so
			// re-read fresh — a winner means this was a paid duplicate and
			// falls into the same refund path, anything else is a real error.
			const winner = await db.select({ id: stripeLifetimeEntitlements.id, checkoutSessionId: stripeLifetimeEntitlements.checkoutSessionId }).from(stripeLifetimeEntitlements).where(and(eq(stripeLifetimeEntitlements.orgId, orgId), eq(stripeLifetimeEntitlements.status, 'active'))).get();
			if (!winner) throw error;
			// The winner may be THIS session's own claim — a duplicate
			// delivery (success redirect + webhook) that lost on the
			// index. ACK as 'already'; refunding it would leave the org
			// with lifetime access it never paid for (codex P1).
			if (winner.checkoutSessionId === sessionId) return 'already';
		}
		await refundUngrantableCheckout(sessionId, orgId, paymentIntent, charge, 'claimed no slot');
		return 'refunded';
	}
	if (result.status === 'active' && result.slot > 0) return 'granted';
	console.error(`stripe: lifetime checkout ${sessionId} for org ${orgId} was PAID but claimed no slot (status ${result.status}, slot ${result.slot}) — manual refund required`);
	return 'rejected';
}

/**
 * Credit-bundle fulfillment: apply the grant idempotently, refund instead
 * when the org went unmetered mid-checkout, drain any reversal that beat
 * the grant, then save the paid card for future auto top-ups.
 */
async function fulfillBundleCheckout(session: Stripe.Checkout.Session, sessionId: string, orgId: string, bundleId: string, paymentIntent: Stripe.PaymentIntent | null, charge: Stripe.Charge | null | undefined): Promise<CheckoutVerdict> {
	const bundle = loadBundle(bundleId, sessionId);
	if (!bundle) return 'rejected';
	return fulfillCreditPurchase(session, sessionId, orgId, creditsForBundle(bundle), paymentIntent, charge);
}

/** Credits a paid test checkout grants (STRIPE_TEST_PRODUCT smoke test). */
const TEST_CHECKOUT_CREDITS = 1;

/**
 * Test-product fulfillment: a paid STRIPE_TEST_PRODUCT checkout grants
 * TEST_CHECKOUT_CREDITS credit through the identical ledger/reversal/card-save
 * path as a real bundle — that shared path is exactly what the operator's
 * smoke test exists to verify.
 */
async function fulfillTestCheckout(session: Stripe.Checkout.Session, sessionId: string, orgId: string, paymentIntent: Stripe.PaymentIntent | null, charge: Stripe.Charge | null | undefined): Promise<CheckoutVerdict> {
	if (session.mode === 'payment') {
		return fulfillCreditPurchase(session, sessionId, orgId, TEST_CHECKOUT_CREDITS, paymentIntent, charge);
	}
	const subscriptionId = stripeId(session.subscription);
	if (session.mode !== 'subscription' || !subscriptionId) {
		console.error(`stripe: test checkout ${sessionId} is neither a payment nor a subscription session`);
		return 'rejected';
	}
	// A recurring test price mints a REAL subscription — cancel it first so a
	// failure below never leaves the smoke test billing monthly. The sub is
	// tagged product:'test' at checkout creation, so the subscription and
	// invoice pipelines ignore it entirely.
	const subscription = asRecord(await getStripe().subscriptions.retrieve(subscriptionId));
	if (!subscription) throw new Error(`stripe: test checkout ${sessionId} returned a malformed subscription ${subscriptionId}`);
	if (subscription.status !== 'canceled') {
		await getStripe().subscriptions.cancel(subscriptionId);
		console.info(`stripe: test checkout ${sessionId} canceled smoke-test subscription ${subscriptionId}`);
	}
	const verdict = await fulfillCreditPurchase(session, sessionId, orgId, TEST_CHECKOUT_CREDITS, paymentIntent, charge);
	// Subscription sessions carry no payment_intent — the card lives on the
	// subscription's default_payment_method. Sync it so the smoke test still
	// exercises the saved-payment-method path the payment-mode run covers.
	const pmId = subscriptionDefaultPmId(subscription, sessionId);
	if (!pmId) {
		console.error(`stripe: test checkout ${sessionId} subscription ${subscriptionId} saved no default payment method`);
	} else {
		await applySubscriptionDefaultPm(orgId, pmId);
	}
	return verdict;
}

/**
 * The shared credit grant behind bundle and test-product checkouts: apply the
 * grant idempotently, refund instead when the org went unmetered mid-checkout,
 * drain any reversal that beat the grant, then save the paid card for future
 * auto top-ups.
 */
async function fulfillCreditPurchase(session: Stripe.Checkout.Session, sessionId: string, orgId: string, credits: number, paymentIntent: Stripe.PaymentIntent | null, charge: Stripe.Charge | null | undefined): Promise<CheckoutVerdict> {
	// Narrow the expanded object once (chargeId prefers the expanded
	// object's id — it is the same id either way).
	const chargeId = typeof paymentIntent?.latest_charge === 'string' ? paymentIntent.latest_charge : charge?.id;
	let applied: boolean;
	try {
		applied = await applyLedgerDelta(db, {
			orgId,
			delta: credits,
			reason: 'purchase',
			refType: 'checkout_session',
			refId: sessionId,
			paymentIntentId: paymentIntent?.id,
			chargeId
		});
	} catch (error) {
		// A checkout opened before the org went lifetime fulfills against an
		// unmetered plan — paid credits that can never be used get refunded
		// (review: the grant, not just checkout creation, must be gated).
		if (!(error instanceof Error && error.message === UNMETERED_CREDIT_GRANT_ERROR)) throw error;
		await refundUngrantableCheckout(sessionId, orgId, paymentIntent, charge, 'the org is on an unmetered plan');
		return 'refunded';
	}
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

/**
 * A paid checkout that cannot grant anything gets its money back — loudly,
 * idempotently (sold-out lifetime, duplicate lifetime, post-upgrade credit
 * purchase). A refund API failure PROPAGATES after a loud MANUAL REFUND
 * REQUIRED log: swallowing it would ACK the delivery and leave the customer
 * charged until a human reads the log — the webhook must 500 so Stripe
 * redelivers and retries the refund under the same idempotency key (review).
 * A paid session with no payment intent throws the same way — a malformed
 * response must never report 'refunded' when nothing was refunded (codex
 * P1). Only the already-refunded path returns normally — nothing a retry
 * could change.
 */
async function refundUngrantableCheckout(
	sessionId: string,
	orgId: string,
	paymentIntent: Stripe.PaymentIntent | null,
	charge: Stripe.Charge | null | undefined,
	reason: string
): Promise<void> {
	if (!paymentIntent?.id) {
		// A PAID session with no payment intent is a malformed Stripe response
		// (I2) — returning would ACK the delivery and report 'refunded' to the
		// buyer when no refund was ever requested. Throw so the delivery stays
		// un-ACKed, Stripe retries, and the MANUAL REFUND REQUIRED line keeps
		// firing until a human refunds (codex P1).
		console.error(`stripe: checkout ${sessionId} for org ${orgId} was PAID but ${reason} and has no payment intent — MANUAL REFUND REQUIRED`);
		throw new Error(`stripe: paid checkout ${sessionId} has no payment intent — MANUAL REFUND REQUIRED`);
	}
	if (charge?.refunded === true) {
		console.error(`stripe: checkout ${sessionId} for org ${orgId} was ungrantable (${reason}) but charge ${charge.id} is already refunded`);
		return;
	}
	await refundUngrantablePayment({
		paymentIntentId: paymentIntent.id,
		idempotencyKey: `refund:ungrantable:${sessionId}`,
		label: `checkout ${sessionId} for org ${orgId} was PAID but ${reason}`,
		orgId,
		checkoutSessionId: sessionId
	});
}

/** Narrows the expanded Checkout session to the payment_intent and its latest_charge (both stay a string-union). */
export function getPaymentIntentAndCharge(session: Stripe.Checkout.Session): {
	paymentIntent: Stripe.PaymentIntent | null;
	charge: Stripe.Charge | null | undefined;
} {
	const paymentIntent = typeof session.payment_intent === 'string' ? null : session.payment_intent;
	const charge = paymentIntent && typeof paymentIntent.latest_charge !== 'string' ? paymentIntent.latest_charge : undefined;
	return { paymentIntent, charge };
}

/** True when the charge backing this session is disputed or fully refunded — a late grant must be refused. */
/**
 * Revalidates the charge's CURRENT state before any late grant (the success
 * page can fulfill an old paid session long after the pending-reversal
 * sweep ran): a refunded or disputed charge must never mint credits. A
 * fully refunded charge reports 'refunded' — the deliberate verdict the
 * success page renders — while a disputed one stays 'rejected' (the money
 * outcome is unresolved, not returned).
 */
/** True when the charge's full amount was refunded — partial refunds keep their purchase (documented v1 scope). */
export function chargeFullyRefunded(charge: { amount?: unknown; amount_refunded?: unknown }): boolean {
	return typeof charge.amount === 'number' && charge.amount > 0 && typeof charge.amount_refunded === 'number' && charge.amount_refunded >= charge.amount;
}

function lateGrantVerdict(session: Stripe.Checkout.Session, sessionId: string): 'refunded' | 'rejected' | null {
	const { charge } = getPaymentIntentAndCharge(session);
	if (!charge) return null;
	const fullyRefunded = chargeFullyRefunded(charge);
	if (charge.disputed || fullyRefunded) {
		console.error(
			`stripe: checkout session ${sessionId} charge ${charge.id} is ${charge.disputed ? 'disputed' : 'fully refunded'} — late grant refused`
		);
		return charge.disputed ? 'rejected' : 'refunded';
	}
	return null;
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
 * Reverses the entitlement side of a refunded or disputed charge. Lifetime
 * purchases lose their slot: a refund releases the entitlement and frees the
 * slot for resale, a dispute marks it disputed while it is contested — either
 * way the org's plan falls back to 'hosted' when an active subscription
 * remains and 'free' otherwise. When no lifetime entitlement matches, the
 * charge's paid subscription period is marked 'refunded' or 'disputed'
 * instead. A dispute-reversal row recorded for the charge is resolved with
 * the matching source ('lifetime' or 'subscription').
 *
 * @param chargeId - The Stripe charge identifier
 * @param reason - Whether the reversal is for a refund or dispute
 * @param paymentIntentId - The charge's payment intent; combined with chargeId it matches the entitlement unambiguously
 * @param disputeId - The dispute id when reason is 'dispute', so its pending reversal row can be resolved
 * @returns `true` if a lifetime entitlement or subscription period was reversed, `false` if neither matched — the caller then falls through to the credit-grant reversal
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
	const entitlementsReversed = await reverseEntitlements(chargeId, reason, paymentIntentId, disputeId);
	// A refund that paid for a subscription must also END the subscription:
	// refundSubscriptionPeriod kills this period's included comments, but an
	// uncanceled subscription stays active and the next invoice.paid would
	// grant a fresh paid period — service resuming on a refunded account.
	// Refunds only: a disputed subscription keeps its lifecycle (the dispute
	// can still be won).
	if (reason === 'refund') await cancelRefundedSubscription(chargeId, paymentIntentId);
	if (entitlementsReversed) return true;
	return reverseCreditGrant(chargeId, reason, disputeId, paymentIntentId);
}

/**
 * Resolves the subscription a refunded charge paid for. The paid period row
 * is the direct link (keyed by the same payment refs refundSubscriptionPeriod
 * matched); when the refund beat invoice.paid and no period exists yet, the
 * charge's InvoicePayment record resolves PI → invoice → subscription (the
 * dahlia Charge carries no invoice back-link). Returns null for charges that
 * paid for no subscription (credit bundle, auto top-up, lifetime).
 */
async function refundedSubscription(chargeId: string, paymentIntentId?: string): Promise<{ subscriptionId: string; orgId?: string } | null> {
	// Same matching rule as refundSubscriptionPeriod: any stored identifier
	// agrees — a period can persist only one ref (codeant P1).
	const periodPredicate = stripeIdentifierPredicate({ paymentIntentId, chargeId }, stripeSubscriptionPeriods.paymentIntentId, stripeSubscriptionPeriods.chargeId);
	const periods = await db
		.select({ subscriptionId: stripeSubscriptionPeriods.subscriptionId, orgId: stripeSubscriptionPeriods.orgId })
		.from(stripeSubscriptionPeriods)
		.where(periodPredicate)
		.limit(2)
		.all();
	if (periods.length > 1) throw new Error(`stripe: refund for ${chargeId} matched multiple subscription periods — refusing to guess which subscription to cancel`);
	if (periods[0]) return periods[0];
	if (!paymentIntentId) return null;
	const payments = await getStripe().invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, status: 'paid' });
	const invoiceId = payments.data.map((item) => stripeId(item.invoice)).find((id) => id !== undefined);
	if (!invoiceId) return null;
	const invoice = asRecord(await getStripe().invoices.retrieve(invoiceId));
	const subscriptionId = invoiceSubscriptionId(invoice);
	if (!subscriptionId) return null; // a one-off invoice, not subscription billing
	return { subscriptionId, orgId: (await findOrgForStripe(subscriptionId))?.id };
}

/**
 * Cancels the Stripe subscription a fully refunded charge paid for — without
 * it, refundSubscriptionPeriod kills this period's included comments but the
 * subscription stays active and the next invoice.paid grants a fresh paid
 * period: service resumes on a refunded account. Idempotent: a canceled or
 * forgotten subscription is skipped. A Stripe failure throws so the delivery
 * stays un-ACKed and retries — an active subscription left behind would keep
 * billing a refunded customer.
 */
async function cancelRefundedSubscription(chargeId: string, paymentIntentId?: string): Promise<void> {
	const match = await refundedSubscription(chargeId, paymentIntentId);
	if (!match) return;
	const live = await fetchLiveSubscription(match.subscriptionId);
	if (!live) {
		console.info(`stripe: refunded charge ${chargeId} — subscription ${match.subscriptionId} is already gone`);
		return;
	}
	const status = live.status;
	if (typeof status !== 'string' || status.length === 0) throw new Error(`Stripe subscription ${match.subscriptionId} carries no usable status`);
	if (subscriptionStatusMeaning(match.subscriptionId, status) === 'terminal') {
		console.info(`stripe: refunded charge ${chargeId} — subscription ${match.subscriptionId} is already ${status}, nothing to cancel`);
		return;
	}
	await getStripe().subscriptions.cancel(match.subscriptionId);
	const orgNote = match.orgId ? ` (org ${match.orgId})` : '';
	console.error(`stripe: subscription ${match.subscriptionId} canceled — charge ${chargeId} was fully refunded${orgNote}; it cannot renew into a new paid period`);
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
	// A charge FULLY REFUNDED after the reversal already paid the customer
	// back — restoring now would mint spendable credits (or revive an
	// entitlement/period) on money we no longer hold (codex P1). Close the
	// reversal 'ignored' so a redelivery cannot re-restore either.
	const charge = await getStripe().charges.retrieve(reversal.chargeId);
	if (chargeFullyRefunded(charge)) {
		console.error(`stripe: won dispute ${disputeId} is not restorable — charge ${reversal.chargeId} was fully refunded`);
		await db.update(stripeDisputeReversals).set({ status: 'ignored' }).where(eq(stripeDisputeReversals.disputeId, disputeId));
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
			if (disputeReversal) {
				try {
					// Dedup-first means a false return is "a previous call already
					// committed this restoration" (a crash between the ledger write
					// and the reversal mark below) — still 'restored', never a wedge.
					await applyLedgerDelta(db, { orgId: match.orgId, delta: match.credits, reason: 'adjust', refType: 'dispute', refId: disputeId, chargeId: reversal.chargeId });
					restored = true;
				} catch (error) {
					// An upgrade to lifetime between the dispute and its win makes
					// the org unmetered — it cannot hold credits, so the honest
					// resolution is "nothing to restore": close the reversal
					// loudly instead of wedging the webhook on the grant guard.
					if (!(error instanceof Error && error.message === UNMETERED_CREDIT_GRANT_ERROR)) throw error;
					console.error(`stripe: won dispute ${disputeId} for unmetered org ${match.orgId} — closing the reversal without re-granting credits`);
					restored = true;
				}
			}
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

/**
 * Reads an invoice's PAID InvoicePayment records — the authoritative source
 * when the event payload omits payment references. `invoice.payments` is an
 * includable property and is NOT guaranteed on the delivered object (the
 * 2026-07-29.dahlia invoice.paid payload omits it entirely); under I2 the
 * missing list is a gap to fetch, not a value to guess at.
 */
async function fetchInvoicePaymentRefs(invoiceId: string): Promise<{ paymentIntentId?: string; chargeId?: string }> {
	const list = await getStripe().invoicePayments.list({ invoice: invoiceId, status: 'paid' });
	for (const item of list.data) {
		const paymentIntentId = stripeId(item.payment?.payment_intent);
		const chargeId = stripeId(item.payment?.charge);
		if (paymentIntentId || chargeId) return { paymentIntentId, chargeId };
	}
	return {};
}

async function invoicePaymentReferences(invoice: StripeRecord, invoiceId: string): Promise<{ paymentIntentId?: string; chargeId?: string }> {
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
	const fetched = await fetchInvoicePaymentRefs(invoiceId);
	if (fetched.paymentIntentId || fetched.chargeId) return fetched;
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
 * The envelope `created` has SECOND precision and event ids carry no
 * documented causal order, so a same-second tie reconciles from the LIVE
 * customer instead of sorting opaque ids (codex P1).
 */
async function handleCustomerUpdated(customer: Stripe.Customer, eventCreated: number | undefined, eventId: string): Promise<void> {
	const org = await findOrgForStripe(undefined, customer.id);
	if (!org) {
		console.info(`stripe: customer.updated for untracked customer ${customer.id} — nothing to sync`);
		return;
	}
	const settings = customer.invoice_settings;
	if (!settings || !('default_payment_method' in settings)) return;
	// I2: out-of-range external data is a failed API call (codex P2). A
	// garbage-but-numeric `created` persisted as the ordering cursor would mark
	// every later legitimate update stale forever — accept only a positive safe
	// integer no more than a day in the future (clock-skew tolerance).
	if (
		typeof eventCreated !== 'number' ||
		!Number.isSafeInteger(eventCreated) ||
		eventCreated <= 0 ||
		eventCreated > Math.floor(Date.now() / 1000) + 86_400
	) {
		throw new Error(`customer.updated ${eventId} carries an invalid envelope created timestamp: ${eventCreated}`);
	}
	let lastCreated = org.stripeCustomerLastEventCreated;
	if (lastCreated !== null && eventCreated < lastCreated) {
		console.error(`stripe: ignoring stale customer.updated ${eventId} for org ${org.id} (created ${eventCreated}, last applied ${lastCreated})`);
		return;
	}
	type OrgSet = { [K in keyof typeof organizations.$inferInsert]?: (typeof organizations.$inferInsert)[K] | SQL };
	// Compare-and-set in the UPDATE itself: two deliveries hold independent
	// inbox leases and can both pass the read-time guard, so the write must
	// re-check the cursor. A PAYLOAD write demands a strictly older cursor; a
	// RECONCILE write accepts an equal one (its value came from the live fetch,
	// which is newer than either tied snapshot).
	const writeDefaultPm = async (pmId: string | null, allowTie: boolean): Promise<boolean> => {
		const cursorAppliable = or(
			isNull(organizations.stripeCustomerLastEventCreated),
			lt(organizations.stripeCustomerLastEventCreated, eventCreated),
			...(allowTie ? [eq(organizations.stripeCustomerLastEventCreated, eventCreated)] : [])
		);
		const set: OrgSet =
			pmId === org.stripeDefaultPmId
				? // No card change, but the cursor must still advance — otherwise a
					// stale snapshot arriving later could resurrect the previous card.
					{ stripeCustomerLastEventCreated: eventCreated, stripeCustomerLastEventId: eventId }
				: {
						stripeDefaultPmId: pmId,
						stripeCustomerLastEventCreated: eventCreated,
						stripeCustomerLastEventId: eventId,
						// Atomic consent reset (codex P1): the CASE decides at row-lock
						// time, so an enable landing INSIDE the read-write window is
						// still disabled — the consent never covered the new card.
						// An org with top-up off keeps its state (no spurious
						// failure-paused 'disabled').
						autoTopupEnabled: sql`CASE WHEN ${organizations.autoTopupEnabled} = 1 THEN 0 ELSE ${organizations.autoTopupEnabled} END`,
						autoTopupState: sql`CASE WHEN ${organizations.autoTopupEnabled} = 1 THEN 'disabled' ELSE ${organizations.autoTopupState} END`
					};
		const res = await db.update(organizations).set(set).where(and(eq(organizations.id, org.id), cursorAppliable));
		return res.rowsAffected > 0;
	};
	// Two attempts bound the race fallout: a payload write that loses to an
	// EQUAL-created cursor means ordering is still undecidable — retry once as
	// a live-customer reconcile before acknowledging.
	for (let attempt = 0; attempt < 2; attempt++) {
		const tied = lastCreated === eventCreated;
		const incomingId = tied ? await fetchLiveDefaultPmId(customer.id, eventId) : eventDefaultPmId(customer, eventId);
		if (await writeDefaultPm(incomingId, tied)) {
			if (incomingId !== org.stripeDefaultPmId) {
				// The disable was decided at row-lock time, so the accurate
				// post-write row state — not the pre-write read — drives the log.
				const after = await db
					.select({ autoTopupEnabled: organizations.autoTopupEnabled, autoTopupState: organizations.autoTopupState })
					.from(organizations)
					.where(eq(organizations.id, org.id))
					.get();
				const change = incomingId ? `${org.stripeDefaultPmId} -> ${incomingId}` : `${org.stripeDefaultPmId} -> cleared`;
				if (after?.autoTopupEnabled === 0 && after.autoTopupState === 'disabled' && org.autoTopupState !== 'disabled') {
					console.error(`stripe: default card changed for org ${org.id} (${change}) — auto top-up DISABLED, fresh consent required`);
				} else {
					console.info(`stripe: default card changed for org ${org.id} (${change})`);
				}
			}
			return;
		}
		if (tied) break; // a reconcile losing means a strictly-newer cursor landed — nothing to redo
		const fresh = await db
			.select({ created: organizations.stripeCustomerLastEventCreated })
			.from(organizations)
			.where(eq(organizations.id, org.id))
			.get();
		if (fresh?.created !== eventCreated) break; // lost to a strictly newer snapshot (or the row is gone)
		lastCreated = fresh.created;
	}
	console.info(`stripe: customer.updated ${eventId} lost the apply race for org ${org.id} — a newer-or-equal snapshot already landed`);
}

/**
 * I2: a present default_payment_method key on the EVENT payload must carry a
 * usable value — null (cleared), a non-empty string id, or an expanded object
 * with a non-empty string id. Anything else ({ id: 123 }, '', {}) is a failed
 * API call: throw so Stripe redelivers rather than freezing garbage into the
 * org row (codex P2). Key ABSENCE is checked by the caller (not a card change).
 */
function eventDefaultPmId(customer: Stripe.Customer, eventId: string): string | null {
	const incoming = customer.invoice_settings?.default_payment_method;
	if (incoming === null) return null;
	if (typeof incoming === 'string' && incoming.length > 0) return incoming;
	if (typeof incoming === 'object' && typeof incoming.id === 'string' && incoming.id.length > 0) return incoming.id;
	throw new Error(`customer.updated ${eventId} carries a malformed default_payment_method`);
}

/**
 * Same-second reconcile (codex P1): on a `created` tie the event payload
 * cannot be ordered, so the default is read from the LIVE customer — the
 * state after every change made up to the fetch. Any failure throws so Stripe
 * redelivers: acknowledging into a frozen stale pointer is worse than a retry.
 */
async function fetchLiveDefaultPmId(customerId: string, eventId: string): Promise<string | null> {
	const live = await getStripe().customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] });
	// A customer deleted at Stripe can never be reconciled — throw so Stripe
	// redelivers; by then account deletion has dropped the org row and the
	// redelivery acknowledges as untracked.
	if ('deleted' in live && live.deleted) {
		throw new Error(`customer.updated ${eventId}: cannot reconcile deleted customer ${customerId}`);
	}
	// On the LIVE object an absent key IS the current state: no default card.
	const value = live.invoice_settings?.default_payment_method;
	if (value === null || value === undefined) return null;
	if (typeof value === 'string' && value.length > 0) return value;
	if (typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0) return value.id;
	throw new Error(`customer.updated ${eventId}: live customer ${customerId} carries a malformed default_payment_method`);
}

/**
 * Reads the card Checkout stored on the subscription itself. Subscription-mode
 * Checkout sets subscription.default_payment_method, NOT
 * customer.invoice_settings.default_payment_method — so customer.updated alone
 * can never observe a hosted subscriber's card. null/absent carries no
 * information (the subscription may fall back to the customer-level default),
 * so only a usable id is returned; a present-but-malformed value is a failed
 * API call — throw so Stripe redelivers (same contract as eventDefaultPmId).
 */
function subscriptionDefaultPmId(subscription: StripeRecord, eventId: string): string | undefined {
	const value = subscription.default_payment_method;
	if (value === null || value === undefined) return undefined;
	if (typeof value === 'string' && value.length > 0) return value;
	const expanded = optionalRecord(value);
	if (expanded && typeof expanded.id === 'string' && expanded.id.length > 0) return expanded.id;
	throw new Error(`Stripe subscription event ${eventId} carries a malformed default_payment_method`);
}

/**
 * Writes the subscription's card as the org's saved top-up card. Only a
 * pointer CHANGE is written; a change under enabled auto top-up disables it
 * atomically pending fresh consent — the consent evidence covered the
 * previous card (same rule as savePaymentMethod and customer.updated).
 * `maxEventCreated` bounds staleness: a subscription event older than the
 * last applied subscription snapshot must not regress the pointer.
 */
async function applySubscriptionDefaultPm(orgId: string, pmId: string, maxEventCreated?: number): Promise<void> {
	const res = await db
		.update(organizations)
		.set({
			stripeDefaultPmId: pmId,
			autoTopupEnabled: sql`CASE WHEN ${organizations.autoTopupEnabled} = 1 THEN 0 ELSE ${organizations.autoTopupEnabled} END`,
			autoTopupState: sql`CASE WHEN ${organizations.autoTopupEnabled} = 1 THEN 'disabled' ELSE ${organizations.autoTopupState} END`
		})
		.where(
			and(
				eq(organizations.id, orgId),
				or(isNull(organizations.stripeDefaultPmId), ne(organizations.stripeDefaultPmId, pmId)),
				...(maxEventCreated === undefined
					? []
					: [or(isNull(organizations.stripeSubscriptionLastEventCreated), lte(organizations.stripeSubscriptionLastEventCreated, maxEventCreated))])
			)
		);
	if (res.rowsAffected === 0) return;
	const after = await db
		.select({ autoTopupEnabled: organizations.autoTopupEnabled, autoTopupState: organizations.autoTopupState })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.get();
	if (after?.autoTopupEnabled === 0 && after.autoTopupState === 'disabled') {
		console.error(`stripe: subscription card changed for org ${orgId} (now ${pmId}) — auto top-up DISABLED, fresh consent required`);
	} else {
		console.info(`stripe: subscription card synced for org ${orgId} (${pmId})`);
	}
}

/**
 * Live Stripe status for a stored subscription. The org row's cached status
 * is untrusted for exclusivity decisions — it stays null until a
 * customer.subscription.* webhook lands, and goes stale whenever deliveries
 * fail (observed: five duplicate subscriptions minted while the webhook
 * endpoint 400ed). A subscription Stripe has forgotten reads as dead.
 */
/**
 * True when the subscription is the operator test product's — checkout.ts
 * tags it product:'test' via subscription_data.metadata. The lookup is a
 * Stripe fetch (the invoice payloads do not reliably carry the tag), so
 * callers only pay it for subscriptions the org does not already track.
 */
async function isTestProductSubscription(subscriptionId: string): Promise<boolean> {
	const sub = await fetchLiveSubscription(subscriptionId);
	return optionalRecord(sub?.metadata)?.product === TEST_CHECKOUT_PRODUCT;
}

async function liveSubscriptionStatus(subscriptionId: string): Promise<string> {
	const live = await fetchLiveSubscription(subscriptionId);
	if (!live) return 'canceled';
	const status = live.status;
	if (typeof status !== 'string' || status.length === 0) throw new Error(`Stripe subscription ${subscriptionId} carries no usable status`);
	return status;
}

async function fetchLiveSubscription(subscriptionId: string): Promise<StripeRecord | null> {
	try {
		return asRecord(await getStripe().subscriptions.retrieve(subscriptionId));
	} catch (cause) {
		const missing =
			cause !== null &&
			typeof cause === 'object' &&
			(cause as { type?: unknown }).type === 'StripeInvalidRequestError' &&
			(cause as { code?: unknown }).code === 'resource_missing';
		if (missing) return null;
		throw cause;
	}
}

/**
 * True when the subscription is scheduled to end — either mechanism: the
 * legacy cancel_at_period_end flag OR the cancel_at timestamp the customer
 * portal writes for end-of-period cancellation (observed live: a portal
 * cancel delivered cancel_at_period_end=false + cancel_at=period_end, which
 * a flag-only read recorded as "not canceling"). An absent cancel_at means
 * "not scheduled"; a present-but-malformed one is a failed API call (I2) —
 * throw so the caller's retry re-reads instead of persisting "still paying".
 */
function subscriptionCancelScheduled(subscription: StripeRecord, context: string): boolean {
	if (typeof subscription.cancel_at_period_end !== 'boolean') throw new Error(`Stripe subscription ${context} has invalid cancel_at_period_end`);
	const cancelAt = subscription.cancel_at;
	if (cancelAt === null || cancelAt === undefined) return subscription.cancel_at_period_end;
	if (typeof cancelAt !== 'number' || !Number.isSafeInteger(cancelAt) || cancelAt <= 0) throw new Error(`Stripe subscription ${context} has invalid cancel_at`);
	// cancel_at is a timestamp, not a promise this period is the last: a
	// value PAST the current period end renews at least once more before
	// the cancel lands — still billing, not winding down (codex P1). The
	// period end can sit on the subscription or its first item (newer API
	// shapes moved it) — same fallback as subscriptionPeriod.
	let periodEnd = subscription.current_period_end;
	if (periodEnd === undefined) {
		const items = optionalRecord(subscription.items);
		const first = Array.isArray(items?.data) ? optionalRecord(items.data[0]) : undefined;
		periodEnd = first?.current_period_end;
	}
	if (typeof periodEnd !== 'number' || !Number.isSafeInteger(periodEnd) || periodEnd <= 0) throw new Error(`Stripe subscription ${context} has invalid current_period_end`);
	return subscription.cancel_at_period_end || cancelAt <= periodEnd;
}

/**
 * LIVE check before a paid lifetime checkout overlaps a hosted subscription:
 * the stored status is only a cache, and a portal resume may not have
 * webhoked yet — so when the cache says the sub is live, Stripe decides. A
 * subscription that is still billing AND not scheduled to end blocks the
 * grant (the caller refunds the ungrantable payment); a scheduled-end or
 * forgotten subscription lets the upgrade through.
 */
async function liveHostedBlocksLifetime(subscriptionId: string, context: string): Promise<boolean> {
	const live = await fetchLiveSubscription(subscriptionId);
	if (!live) return false;
	const status = live.status;
	if (typeof status !== 'string' || status.length === 0) throw new Error(`Stripe subscription ${subscriptionId} carries no usable status`);
	return isActiveSubscriptionStatus(status) && !subscriptionCancelScheduled(live, context);
}

/**
 * Stripe's documented subscription statuses split into still-billable and
 * done. 'live' is the active set plus 'incomplete' (first payment may still
 * land) and 'paused' (can resume); 'terminal' is 'canceled' and
 * 'incomplete_expired'. Anything else is a failed read or a status this
 * build predates — silently filing it as terminal would skip a needed
 * cancel while the refund leg runs (codex P2), so unknown = loud (I2).
 */
function subscriptionStatusMeaning(subscriptionId: string, status: string): 'live' | 'terminal' {
	if (isActiveSubscriptionStatus(status) || status === 'incomplete' || status === 'paused') return 'live';
	if (status === 'canceled' || status === 'incomplete_expired') return 'terminal';
	throw new Error(`Stripe subscription ${subscriptionId} carries an unknown status '${status}'`);
}

/**
 * One live subscription per org, ever. A second live subscription on the
 * org's customer is a duplicate that keeps billing the buyer: cancel it at
 * Stripe (stops all future invoices) and refund its first paid invoice
 * payment. Idempotent — a live check skips the cancel once the subscription
 * is terminal (Stripe would error on the second call) and the refund
 * anchors on a per-subscription key, so the fulfillment and subscription-
 * event paths converging on the same duplicate never double-refund.
 * `paymentExpected` distinguishes callers that KNOW money moved (a paid
 * checkout session, an invoice.paid): a missing paid payment there is a
 * loud retry, while subscription-lifecycle events tolerate an invoice that
 * has not settled yet — the duplicate's own invoice.paid refunds it later.
 */
async function teardownDuplicateSubscription(duplicateSubscriptionId: string, orgId: string, opts: { checkoutSessionId?: string; invoiceId?: string; paymentExpected: boolean }): Promise<void> {
	// Live-check before canceling: Stripe rejects canceling a subscription
	// that is already terminal, and a redelivery or a late terminal event can
	// land here after the first teardown did the job — the throw would fail
	// the delivery before the refund leg below ever retries (cubic P1).
	const live = await fetchLiveSubscription(duplicateSubscriptionId);
	let canceled: StripeRecord;
	if (!live) {
		// resource_missing means the subscription is gone — canceling a
		// subscription Stripe no longer has would 400 and fail the delivery
		// before the refund leg ever retries (coderabbit).
		console.info(`stripe: duplicate subscription ${duplicateSubscriptionId} for org ${orgId} is already gone — skipping the cancel`);
		canceled = {};
	} else {
		const liveStatus = typeof live.status === 'string' && live.status.length > 0 ? live.status : undefined;
		if (!liveStatus) throw new Error(`Stripe subscription ${duplicateSubscriptionId} carries no usable status`);
		if (subscriptionStatusMeaning(duplicateSubscriptionId, liveStatus) === 'terminal') {
			console.info(`stripe: duplicate subscription ${duplicateSubscriptionId} for org ${orgId} is already ${liveStatus} — skipping the second cancel`);
			canceled = live;
		} else {
			canceled = asRecord(await getStripe().subscriptions.cancel(duplicateSubscriptionId));
			console.error(`stripe: canceled duplicate subscription ${duplicateSubscriptionId} for org ${orgId} — only one live subscription per org is allowed`);
		}
	}
	// Refund every paid payment the duplicate collected: the invoice the
	// caller KNOWS about (an invoice.paid payload or the canceled record's
	// latest) AND every other paid invoice on the subscription — a duplicate
	// that survived a webhook outage can have billed multiple cycles, and
	// refunding only the latest leaves the earlier charges with us (codex
	// P1). Each refund anchors on a PER-PAYMENT idempotency key so retries
	// and separate payments never collide.
	const invoiceIds = new Set<string>();
	const knownInvoiceId = opts.invoiceId ?? stripeId(canceled.latest_invoice);
	if (knownInvoiceId) invoiceIds.add(knownInvoiceId);
	if (live) {
		const paid = await getStripe().invoices.list({ subscription: duplicateSubscriptionId, status: 'paid', limit: 100 });
		for (const invoice of paid.data) {
			const id = stripeId(asRecord(invoice).id);
			if (id) invoiceIds.add(id);
		}
	}
	let refundedAny = false;
	let honoredAny = false;
	let unrefundable = false;
	for (const invoiceId of invoiceIds) {
		// A period row for this invoice means the payment was HONORED — the
		// customer received the service. Refunding delivered service is a
		// clawback, not a duplicate-charge correction: a delayed invoice.paid
		// for a legit old subscription must not refund just because the org
		// later resubscribed (codex P1). Any status counts — a 'refunded' or
		// 'disputed' period is already owned by the charge.refunded/dispute
		// reversal path.
		if (await subscriptionInvoiceWasHonored(invoiceId)) {
			console.info(`stripe: invoice ${invoiceId} on superseded subscription ${duplicateSubscriptionId} already produced a period — leaving the honored payment`);
			honoredAny = true;
			continue;
		}
		const refs = await fetchInvoicePaymentRefs(invoiceId);
		if (!refs.paymentIntentId && !refs.chargeId) continue; // never settled — nothing moved
		if (!refs.paymentIntentId) {
			unrefundable = true;
			continue;
		}
		await refundUngrantablePayment({
			paymentIntentId: refs.paymentIntentId,
			idempotencyKey: `refund:ungrantable:subscription:${duplicateSubscriptionId}:payment:${refs.paymentIntentId}`,
			label: `duplicate hosted subscription ${duplicateSubscriptionId} for org ${orgId}`,
			orgId,
			checkoutSessionId: opts.checkoutSessionId
		});
		refundedAny = true;
	}
	if (unrefundable || (opts.paymentExpected && !refundedAny && !honoredAny)) {
		// A paid payment exists but cannot be auto-refunded (charge-only), or
		// the money is provably taken yet invisible to invoicePayments — either
		// way a human must refund: throw so the delivery stays un-ACKed.
		console.error(`stripe: duplicate subscription ${duplicateSubscriptionId} for org ${orgId} was canceled but its payment could not be auto-refunded — MANUAL REFUND REQUIRED`);
		throw new Error(`stripe: duplicate subscription ${duplicateSubscriptionId} canceled but its paid payment was not refundable — MANUAL REFUND REQUIRED`);
	}
	if (!refundedAny && !honoredAny) {
		console.info(`stripe: duplicate subscription ${duplicateSubscriptionId} for org ${orgId} canceled; no paid invoice payment to refund yet`);
	}
}

/**
 * True when a subscription invoice already produced a period row — the
 * payment bought service the org received. The teardown refund leg skips
 * honored payments so a delayed invoice.paid for a legitimate superseded
 * subscription is never clawed back (codex P1).
 */
async function subscriptionInvoiceWasHonored(invoiceId: string): Promise<boolean> {
	const row = await db.select({ id: stripeSubscriptionPeriods.id }).from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, invoiceId)).get();
	return Boolean(row);
}

/**
 * The org tracks ONE subscription. An event naming a different subscription
 * is superseded ONLY while the tracked one is actually live at Stripe — a
 * dead tracked subscription means the incoming event belongs to a
 * resubscribe and must apply (its invoice.paid grants the first period even
 * when it beats checkout.session.completed to the endpoint).
 */
async function isSupersededSubscription(org: Awaited<ReturnType<typeof findOrgForStripe>>, subscriptionId: string, eventType: string): Promise<boolean> {
	if (!org?.stripeSubscriptionId || org.stripeSubscriptionId === subscriptionId) return false;
	const live = await liveSubscriptionStatus(org.stripeSubscriptionId);
	if (subscriptionStatusMeaning(org.stripeSubscriptionId, live) !== 'live') {
		console.info(`stripe: tracked subscription ${org.stripeSubscriptionId} is ${live} — ${eventType} for ${subscriptionId} may proceed`);
		return false;
	}
	console.error(`stripe: ignoring stale ${eventType} for superseded subscription ${subscriptionId}; live subscription ${org.stripeSubscriptionId} (${live}) is still tracked for org ${org.id}`);
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
	// An untracked subscription billing the org's customer could be the
	// recurring test product — check its metadata before the
	// resubscribe/duplicate logic: a test invoice grants no period credits
	// (fulfillTestCheckout handles the whole smoke test).
	if (subscriptionId !== org.stripeSubscriptionId && (await isTestProductSubscription(subscriptionId))) {
		console.info(`stripe: ignoring invoice.paid ${invoiceId} for test-product subscription ${subscriptionId}`);
		return;
	}
	if (await isSupersededSubscription(org, subscriptionId, 'invoice.paid')) {
		// An untracked subscription that is billing the org's customer anyway:
		// cancel it and refund this paid invoice (paymentExpected — the invoice
		// literally just reported paid).
		await teardownDuplicateSubscription(subscriptionId, org.id, { invoiceId, paymentExpected: true });
		return;
	}
	const { periodStart, periodEnd } = invoicePeriod(invoice, subscriptionId);
	const payment = await invoicePaymentReferences(invoice, invoiceId);
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
	if (subscriptionId && subscriptionId !== org.stripeSubscriptionId && (await isTestProductSubscription(subscriptionId))) {
		console.info(`stripe: ignoring invoice.payment_failed for test-product subscription ${subscriptionId}`);
		return;
	}
	if (subscriptionId && (await isSupersededSubscription(org, subscriptionId, 'invoice.payment_failed'))) {
		// No payment landed on this invoice — cancel the duplicate; nothing to refund.
		await teardownDuplicateSubscription(subscriptionId, org.id, { paymentExpected: false });
		return;
	}
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
	// The operator test product's subscription (recurring STRIPE_TEST_PRODUCT)
	// is never the org's plan — ignore it before it can be tracked, torn
	// down as a "duplicate", or mark the org past_due.
	if (optionalRecord(subscription.metadata)?.product === TEST_CHECKOUT_PRODUCT) {
		console.info(`stripe: ignoring ${event.type} for test-product subscription ${subscriptionId}`);
		return;
	}
	const org = await findOrgForStripe(subscriptionId, customerId);
	if (!org) {
		console.error(`stripe: ${event.type} ${subscriptionId} has no mapped organization`);
		return;
	}
	if (await isSupersededSubscription(org, subscriptionId, event.type)) {
		// A terminal event for the superseded subscription is just its death
		// notice arriving late — it is already dead at Stripe, so there is
		// nothing to cancel and nothing provably paid to refund. Tearing it
		// down anyway would double-cancel (a Stripe error → endless retries)
		// and could refund an invoice that was never a duplicate charge.
		if (subscriptionStatusMeaning(subscriptionId, status) === 'terminal') {
			console.info(`stripe: ignoring terminal ${event.type} for superseded subscription ${subscriptionId} (status ${status}) — tracked subscription ${org.stripeSubscriptionId} stays`);
			return;
		}
		// A second live subscription is a duplicate — cancel + refund it rather
		// than letting it displace the tracked one or keep billing silently.
		await teardownDuplicateSubscription(subscriptionId, org.id, { paymentExpected: false });
		return;
	}
	const { periodStart, periodEnd } = subscriptionPeriod(subscription, event.id);
	const canceling = subscriptionCancelScheduled(subscription, event.id);
	const pmId = subscriptionDefaultPmId(subscription, event.id);
	const applied = await applySubscriptionSnapshot({
		orgId: org.id,
		subscriptionId,
		status,
		periodStart,
		periodEnd,
		cancelAtPeriodEnd: canceling,
		eventCreated: event.created,
		eventId: event.id
	});
	if (!applied) {
		// A strictly-older event is provably stale — acknowledge quietly. But
		// a SAME-SECOND tie is decided by opaque event-id order, which carries
		// no causality: a portal resume whose id sorts lower is dropped even
		// though Stripe's live record may already show the subscription
		// billing again (codex P1). Before trusting the drop, reconcile the
		// enforcement decision from the LIVE subscription — the same rule
		// customer.updated applies to its card pointer.
		const cursor = await db.select({ created: organizations.stripeSubscriptionLastEventCreated }).from(organizations).where(eq(organizations.id, org.id)).get();
		if (cursor?.created === event.created) {
			const live = await fetchLiveSubscription(subscriptionId);
			if (live) {
				const liveStatus = typeof live.status === 'string' && live.status.length > 0 ? live.status : undefined;
				if (!liveStatus) throw new Error(`Stripe subscription ${subscriptionId} carries no usable status`);
				if (subscriptionStatusMeaning(subscriptionId, liveStatus) === 'live') {
					await endSubscriptionOnLifetimeOrg(org.id, subscriptionId, event, liveStatus, subscriptionCancelScheduled(live, event.id));
				}
			}
		}
		console.info(`stripe: ${event.type} ${event.id} for subscription ${subscriptionId} is stale — a same-or-newer snapshot already applied`);
		return;
	}
	// Only a snapshot this event actually applied may carry its card — a stale
	// event's payment method is equally stale.
	if (pmId) await applySubscriptionDefaultPm(org.id, pmId, event.created);
	await endSubscriptionOnLifetimeOrg(org.id, subscriptionId, event, status, canceling);
}

/**
 * A lifetime org must never keep paying for hosted access. Lifetime can be
 * bought while a subscription is merely SCHEDULED to end, so the one way back
 * to a live-and-billing sub is a portal resume (or an out-of-band new one).
 * When the freshest snapshot says the tracked subscription is live and not
 * ending on a lifetime org, re-schedule its cancellation at period end — the
 * Terms' cancellation rule, and it preserves the paid remainder — and scream.
 * A Stripe failure throws so the delivery stays un-ACKed and retries.
 */
async function endSubscriptionOnLifetimeOrg(orgId: string, subscriptionId: string, event: Stripe.Event, status: string, canceling: boolean): Promise<void> {
	if (canceling || !isActiveSubscriptionStatus(status)) return;
	const lifetime = await db.select({ id: stripeLifetimeEntitlements.id }).from(stripeLifetimeEntitlements).where(and(eq(stripeLifetimeEntitlements.orgId, orgId), eq(stripeLifetimeEntitlements.status, 'active'))).get();
	if (!lifetime) return;
	console.error(`stripe: ${event.type} ${event.id} shows subscription ${subscriptionId} live and not ending on lifetime org ${orgId} — re-scheduling its cancellation at period end so it cannot bill alongside the lifetime plan`);
	await getStripe().subscriptions.update(subscriptionId, { cancel_at_period_end: true });
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
/**
 * Processes the terminal status of refunds WE created for ungrantable
 * payments (tagged `reason: 'ungrantable'` at create — the Stripe-side
 * persistence that identifies them, codex P1). A failed/canceled refund on
 * an ACKed delivery means the customer is still charged for a purchase we
 * could never grant: scream for a human refund. Succeeded refunds need no
 * action — the create-time log already recorded them.
 */
async function handleUngrantableRefundUpdate(refund: Stripe.Refund): Promise<void> {
	if (refund.metadata?.reason !== 'ungrantable') return;
	if (refund.status !== 'failed' && refund.status !== 'canceled') return;
	const pi = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
	// Durable operator record BEFORE the throw: a session-linked refund marks
	// its checkout attempt 'manual_refund_required' — a queryable row that
	// outlives the event's retry horizon and log rotation (codex P1).
	// PI-only refunds (auto top-up) have no attempt row; the throw keeps
	// their delivery in Stripe's failed-events queue as the operator
	// surface, so redeliveries keep screaming until a human refunds.
	if (refund.metadata?.checkout_session_id) {
		await db.update(stripeCheckoutAttempts).set({ status: 'manual_refund_required' }).where(eq(stripeCheckoutAttempts.stripeSessionId, refund.metadata.checkout_session_id));
	}
	console.error(`stripe: ungrantable refund ${refund.id} for payment intent ${pi ?? 'unknown'} resolved ${refund.status} — the customer is still charged, MANUAL REFUND REQUIRED`);
	throw new Error(`stripe: ungrantable refund ${refund.id} resolved ${refund.status} — MANUAL REFUND REQUIRED`);
}

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
			// (refund.created) are intentionally unhandled, and
			// reversing after the credits are spent can leave a negative balance
			// — both documented v1 limitations (docs/stripe-checkout-webhooks.md §7).
			await reverseCharge(event.data.object.id, 'refund');
			handled = true;
			break;
		case 'charge.refund.updated':
		case 'refund.updated':
		case 'refund.failed': {
			// data.object is the Refund. We only escalate OUR ungrantable
			// refunds (tagged reason:'ungrantable' at create): a pending or
			// requires_action refund was ACKed as in-flight — if Stripe later
			// reports a terminal failure the customer is still charged for an
			// ungrantable purchase, and without this no signal exists (codex
			// P1). refund.updated is the broader event — charge.refund.updated
			// is emitted only for selected payment methods (CodeRabbit) — and
			// refund.failed covers a refund that arrives already failed; all
			// three route here (the status check filters), ordinary refunds
			// stay quiet.
			await handleUngrantableRefundUpdate(event.data.object);
			handled = true;
			break;
		}
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
