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

import { and, eq, isNull } from 'drizzle-orm';

import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { organizations, stripeLifetimeEntitlements, stripeLifetimeSlots } from '$lib/server/db/schema';
import { bundleById, priceIdFor, type CreditBundle } from '$lib/server/stripe/bundles';
import { planPriceEnv, validatePlanPrice, type PaidPlan } from './plans';
import { getStripe } from '$lib/server/stripe/client';
import { requireOrgRole } from '$lib/server/ownership';
import type { SessionUser } from '$lib/server/session';

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

/**
 * Creates a Stripe Checkout Session for a credit bundle.
 *
 * @param orgId - The organization receiving the credits
 * @param bundleId - The identifier of the credit bundle to purchase
 * @returns The Checkout Session URL
 * @throws If the application URL is not configured or Stripe does not provide a Checkout URL
 */
export async function createCreditCheckout(orgId: string, user: SessionUser, bundleId: string): Promise<string> {
	requireOrgRole(user, 'owner');
	const bundle: CreditBundle = bundleById(bundleId);
	const appUrl = env.APP_URL;
	if (!appUrl) throw new Error('APP_URL is not configured');
	const customer = await getOrCreateStripeCustomer(orgId, user);
	const session = await getStripe().checkout.sessions.create({
		mode: 'payment',
		line_items: [{ price: priceIdFor(bundle), quantity: 1 }],
		customer,
		client_reference_id: orgId,
		metadata: { org_id: orgId, bundle: bundle.id, credits: String(bundle.credits) },
		payment_intent_data: { setup_future_usage: 'off_session' },
		// new URL(path, base) per the repo URL-construction guideline — the
		// literal {CHECKOUT_SESSION_ID} placeholder must survive verbatim.
		success_url: new URL('/usage/success?session_id={CHECKOUT_SESSION_ID}', appUrl).toString(),
		cancel_url: new URL('/usage', appUrl).toString()
	});
	if (!session.url) throw new Error(`stripe returned no Checkout URL for session ${session.id}`);
	return session.url;
}


/**
 * Creates a Checkout Session for one of the hosted products. The application
 * owns the catalog: Stripe's configured Price is retrieved and checked before
 * any Checkout session is created, and fulfillment rechecks the metadata and
 * mode in the webhook.
 */
export async function createPlanCheckout(orgId: string, user: SessionUser, plan: PaidPlan): Promise<string> {
	requireOrgRole(user, 'owner');
	const appUrl = env.APP_URL;
	if (!appUrl) throw new Error('APP_URL is not configured');
	const org = await db
		.select({
			plan: organizations.plan,
			stripeSubscriptionId: organizations.stripeSubscriptionId,
			stripeSubscriptionStatus: organizations.stripeSubscriptionStatus
		})
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.get();
	if (!org) throw new Error(`org not found: ${orgId}`);
	if (plan === 'hosted' && org.stripeSubscriptionId && ['active', 'trialing', 'past_due', 'unpaid'].includes(org.stripeSubscriptionStatus ?? '')) {
		throw new Error('organization already has a hosted subscription');
	}
	if (plan === 'lifetime') {
		if (org.plan === 'lifetime') throw new Error('organization already has the lifetime plan');
		const available = await db
			.select({ slot: stripeLifetimeSlots.slot })
			.from(stripeLifetimeSlots)
			.where(isNull(stripeLifetimeSlots.activeOrgId))
			.limit(1)
			.get();
		if (!available) throw new Error('lifetime plan is sold out');
	}
	const priceId = env[planPriceEnv(plan)];
	if (!priceId) throw new Error(`${planPriceEnv(plan)} is not configured`);
	if (!priceId.startsWith('price_')) throw new Error(`${planPriceEnv(plan)} must be a Stripe Price id (price_...)`);
	const price = await getStripe().prices.retrieve(priceId);
	validatePlanPrice(plan, price);
	const customer = await getOrCreateStripeCustomer(orgId, user);
	const metadata = { org_id: orgId, product: plan };
	const session = await getStripe().checkout.sessions.create(
		{
			mode: plan === 'hosted' ? 'subscription' : 'payment',
			line_items: [{ price: priceId, quantity: 1 }],
			customer,
			client_reference_id: orgId,
			metadata,
			...(plan === 'hosted' ? { subscription_data: { metadata } } : {}),
			success_url: new URL('/usage/success?session_id={CHECKOUT_SESSION_ID}', appUrl).toString(),
			cancel_url: new URL('/usage', appUrl).toString()
		},
		{ idempotencyKey: `checkout:${orgId}:${plan}` }
	);
	if (!session.url) throw new Error(`stripe returned no Checkout URL for session ${session.id}`);
	return session.url;
}
