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

// Checkout session creation for credit bundles. The success page and the
// webhook BOTH run fulfillment (docs/stripe-checkout-webhooks.md §2 — the
// success-page redirect is not reliable, the webhook is authoritative); both
// are idempotent, so instant UX and eventual delivery never double-grant.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { organizations, stripeCheckoutAttempts, stripeLifetimeEntitlements, stripeLifetimeSlots } from '$lib/server/db/schema';
import { bundleById, priceIdFor, type CreditBundle } from '$lib/server/stripe/bundles';
import { isActiveSubscriptionStatus, planPriceEnv, validatePlanPrice, type PaidPlan } from './plans';
import { getStripe } from '$lib/server/stripe/client';
import { requireOrgRole } from '$lib/server/ownership';
import type { SessionUser } from '$lib/server/session';

const HOSTED_PLAN_EXISTS_ERROR = 'organization already has a hosted subscription';
const ACTIVE_HOSTED_PLAN_ERROR = 'organization already has an active hosted subscription';
const LIFETIME_PLAN_EXISTS_ERROR = 'organization already has the lifetime plan';
const LIFETIME_SOLD_OUT_ERROR = 'lifetime plan is sold out';

/**
 * Retrieves the organization's Stripe customer ID, creating and storing one when needed.
 *
 * @param orgId - The organization identifier
 * @param user - The authenticated organization owner
 * @returns The organization's Stripe customer ID
 * @throws If the organization does not exist
 */
export async function getOrCreateStripeCustomer(orgId: string, user: SessionUser): Promise<string> {
	requireOrgRole(user, 'owner');
	const org = await db
		.select({ stripeCustomerId: organizations.stripeCustomerId })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.get();
	if (!org) throw new Error(`org not found: ${orgId}`);
	if (org.stripeCustomerId) return org.stripeCustomerId;
	// Stable per-org idempotency key: two concurrent Checkout requests that
	// both read a missing customer id collapse into ONE Stripe customer
	// (coderabbit — without it each request would mint a different customer).
	const customer = await getStripe().customers.create(
		{
			name: user.orgName,
			email: user.email,
			metadata: { org_id: orgId }
		},
		{ idempotencyKey: `customer:${orgId}` }
	);
	// Conditional claim: only the first caller to land stores its customer.
	// A losing claim re-reads the org row and returns the STORED id — Checkout
	// Sessions and saved payment methods must attach to the org's real
	// customer, never a concurrent orphan.
	const stored = await db
		.update(organizations)
		.set({ stripeCustomerId: customer.id })
		.where(and(eq(organizations.id, orgId), isNull(organizations.stripeCustomerId)))
		.returning({ id: organizations.id });
	if (stored.length === 0) {
		const current = await db
			.select({ stripeCustomerId: organizations.stripeCustomerId })
			.from(organizations)
			.where(eq(organizations.id, orgId))
			.get();
		if (current?.stripeCustomerId) return current.stripeCustomerId;
		// The org row vanished mid-flight (account deleted concurrently) —
		// fail loudly instead of handing out an unowned customer.
		throw new Error(`org not found: ${orgId}`);
	}
	return customer.id;
}

function checkoutRedirectUrls(appUrl: string): { success_url: string; cancel_url: string } {
	return {
		success_url: new URL('/usage/success?session_id={CHECKOUT_SESSION_ID}', appUrl).toString(),
		cancel_url: new URL('/usage', appUrl).toString()
	};
}

/**
 * Creates a Stripe Checkout Session for a credit bundle.
 *
 * @param orgId - The organization receiving the credits
 * @param bundleId - The identifier of the credit bundle to purchase
 * @returns The Checkout Session URL
 * @throws If the application URL is not configured or Stripe does not provide a Checkout URL
 */
export async function createCreditCheckout(orgId: string, user: SessionUser, bundleId: string, attemptId?: string): Promise<string> {
	requireOrgRole(user, 'owner');
	const bundle: CreditBundle = bundleById(bundleId);
	const appUrl = env.APP_URL;
	if (!appUrl) throw new Error('APP_URL is not configured');
	return createCheckoutAttempt(orgId, bundle.id, attemptId, async (idempotencyKey) => {
		const customer = await getOrCreateStripeCustomer(orgId, user);
		return getStripe().checkout.sessions.create({
			mode: 'payment',
			line_items: [{ price: priceIdFor(bundle), quantity: 1 }],
			customer,
			client_reference_id: orgId,
			metadata: { org_id: orgId, bundle: bundle.id, credits: String(bundle.credits) },
			payment_intent_data: { setup_future_usage: 'off_session' },
			// new URL(path, base) per the repo URL-construction guideline — the
			// literal {CHECKOUT_SESSION_ID} placeholder must survive verbatim.
			...checkoutRedirectUrls(appUrl)
		}, { idempotencyKey });
	});
}


const CHECKOUT_ATTEMPT_ID = /^[A-Za-z0-9_-]{8,128}$/;

type CheckoutAttempt = {
	attemptId: string;
	orgId: string;
	product: string;
	idempotencyKey: string;
	stripeSessionId: string | null;
	status: string;
};

function checkoutAttemptId(input?: string): string {
	if (input === undefined || input === '') return randomUUID();
	if (!CHECKOUT_ATTEMPT_ID.test(input)) throw new Error('checkout attempt id is invalid');
	return input;
}

async function loadOrCreateCheckoutAttempt(orgId: string, product: string, suppliedAttemptId?: string): Promise<CheckoutAttempt> {
	const attemptId = checkoutAttemptId(suppliedAttemptId);
	const idempotencyKey = `checkout:${attemptId}:${randomUUID()}`;
	const inserted = await db.insert(stripeCheckoutAttempts).values({ attemptId, orgId, product, idempotencyKey }).onConflictDoNothing({ target: stripeCheckoutAttempts.attemptId }).returning({ attemptId: stripeCheckoutAttempts.attemptId, orgId: stripeCheckoutAttempts.orgId, product: stripeCheckoutAttempts.product, idempotencyKey: stripeCheckoutAttempts.idempotencyKey, stripeSessionId: stripeCheckoutAttempts.stripeSessionId, status: stripeCheckoutAttempts.status }).all();
	if (inserted.length === 1) return inserted[0];
	const existing = await db.select({ attemptId: stripeCheckoutAttempts.attemptId, orgId: stripeCheckoutAttempts.orgId, product: stripeCheckoutAttempts.product, idempotencyKey: stripeCheckoutAttempts.idempotencyKey, stripeSessionId: stripeCheckoutAttempts.stripeSessionId, status: stripeCheckoutAttempts.status }).from(stripeCheckoutAttempts).where(eq(stripeCheckoutAttempts.attemptId, attemptId)).get();
	if (!existing) throw new Error(`checkout attempt ${attemptId} disappeared while creating`);
	if (existing.orgId !== orgId || existing.product !== product) throw new Error('checkout attempt does not belong to this purchase');
	return existing;
}

async function resolveExistingCheckout(attempt: CheckoutAttempt): Promise<{ url?: string; idempotencyKey: string }> {
	if (attempt.status === 'fulfilled') throw new Error('checkout attempt has already completed');
	if (!attempt.stripeSessionId) return { idempotencyKey: attempt.idempotencyKey };
	const session = await getStripe().checkout.sessions.retrieve(attempt.stripeSessionId);
	if (session.id !== attempt.stripeSessionId) throw new Error(`Stripe returned the wrong Checkout Session for attempt ${attempt.attemptId}`);
	if (session.status === 'open') {
		if (!session.url) throw new Error(`Stripe Checkout Session ${session.id} has no URL`);
		return { url: session.url, idempotencyKey: attempt.idempotencyKey };
	}
	if (session.status === 'complete') {
		await db.update(stripeCheckoutAttempts).set({ status: 'fulfilled', updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(eq(stripeCheckoutAttempts.attemptId, attempt.attemptId));
		throw new Error('checkout attempt has already completed');
	}
	if (session.status === 'expired') {
		const idempotencyKey = `checkout:${attempt.attemptId}:${randomUUID()}`;
		await db.update(stripeCheckoutAttempts).set({ stripeSessionId: null, status: 'pending', idempotencyKey, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(eq(stripeCheckoutAttempts.attemptId, attempt.attemptId));
		return { idempotencyKey };
	}
	throw new Error(`Stripe Checkout Session ${session.id} has an invalid status`);
}

function createdCheckoutSession(session: { id?: unknown; url?: unknown }): { id: string; url: string } {
	if (typeof session.id !== 'string' || session.id.length === 0) throw new Error('Stripe returned a Checkout Session without an id');
	if (typeof session.url !== 'string' || session.url.length === 0) throw new Error(`stripe returned no Checkout URL for session ${session.id}`);
	return { id: session.id, url: session.url };
}

async function createCheckoutAttempt(
	orgId: string,
	product: string,
	suppliedAttemptId: string | undefined,
	create: (idempotencyKey: string) => Promise<{ id?: unknown; url?: unknown }>
): Promise<string> {
	const attempt = await loadOrCreateCheckoutAttempt(orgId, product, suppliedAttemptId);
	const existing = await resolveExistingCheckout(attempt);
	if (existing.url) return existing.url;
	const session = createdCheckoutSession(await create(existing.idempotencyKey));
	const updated = await db.update(stripeCheckoutAttempts).set({ stripeSessionId: session.id, status: 'open', updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(eq(stripeCheckoutAttempts.attemptId, attempt.attemptId)).returning({ id: stripeCheckoutAttempts.id });
	if (updated.length !== 1) throw new Error(`checkout attempt ${attempt.attemptId} disappeared while saving Stripe Session ${session.id}`);
	return session.url;
}

export async function markCheckoutAttemptFulfilled(sessionId: string): Promise<void> {
	await db.update(stripeCheckoutAttempts).set({ status: 'fulfilled', updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(eq(stripeCheckoutAttempts.stripeSessionId, sessionId));
}

async function assertPlanAvailable(orgId: string, plan: PaidPlan): Promise<void> {
	const org = await db.select({ plan: organizations.plan, stripeSubscriptionId: organizations.stripeSubscriptionId, stripeSubscriptionStatus: organizations.stripeSubscriptionStatus }).from(organizations).where(eq(organizations.id, orgId)).get();
	if (!org) throw new Error(`org not found: ${orgId}`);
	const hasActiveHosted = Boolean(org.stripeSubscriptionId && isActiveSubscriptionStatus(org.stripeSubscriptionStatus));
	const lifetime = await db.select({ id: stripeLifetimeEntitlements.id }).from(stripeLifetimeEntitlements).where(and(eq(stripeLifetimeEntitlements.orgId, orgId), eq(stripeLifetimeEntitlements.status, 'active'))).get();
	if (plan === 'hosted') {
		if (hasActiveHosted) throw new Error(HOSTED_PLAN_EXISTS_ERROR);
		if (org.plan === 'lifetime' || lifetime) throw new Error(LIFETIME_PLAN_EXISTS_ERROR);
		return;
	}
	if (hasActiveHosted) throw new Error(ACTIVE_HOSTED_PLAN_ERROR);
	if (org.plan === 'lifetime' || lifetime) throw new Error(LIFETIME_PLAN_EXISTS_ERROR);
	const available = await db.select({ slot: stripeLifetimeSlots.slot }).from(stripeLifetimeSlots).where(isNull(stripeLifetimeSlots.activeOrgId)).limit(1).get();
	if (!available) throw new Error(LIFETIME_SOLD_OUT_ERROR);
}

function configuredPlanPriceId(plan: PaidPlan): string {
	const priceId = env[planPriceEnv(plan)];
	if (!priceId) throw new Error(`${planPriceEnv(plan)} is not configured`);
	if (!priceId.startsWith('price_')) throw new Error(`${planPriceEnv(plan)} must be a Stripe Price id (price_...)`);
	return priceId;
}

/**
 * Creates a Checkout Session for one of the hosted products. The application
 * owns the catalog: Stripe's configured Price is retrieved and checked before
 * any Checkout session is created, and fulfillment rechecks the metadata and
 * mode in the webhook.
 */
export async function createPlanCheckout(orgId: string, user: SessionUser, plan: PaidPlan, attemptId?: string): Promise<string> {
	requireOrgRole(user, 'owner');
	const appUrl = env.APP_URL;
	if (!appUrl) throw new Error('APP_URL is not configured');
	return createCheckoutAttempt(orgId, plan, attemptId, async (idempotencyKey) => {
		await assertPlanAvailable(orgId, plan);
		const priceId = configuredPlanPriceId(plan);
		const price = await getStripe().prices.retrieve(priceId);
		validatePlanPrice(plan, price);
		const customer = await getOrCreateStripeCustomer(orgId, user);
		const metadata = { org_id: orgId, product: plan };
		return getStripe().checkout.sessions.create(
			{
				mode: plan === 'hosted' ? 'subscription' : 'payment',
				line_items: [{ price: priceId, quantity: 1 }],
				customer,
				client_reference_id: orgId,
				metadata,
				...(plan === 'hosted' ? { subscription_data: { metadata } } : {}),
				...checkoutRedirectUrls(appUrl)
			},
			{ idempotencyKey }
		);
	});
}
