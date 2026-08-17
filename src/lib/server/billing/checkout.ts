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

// Checkout session creation for credit bundles. The success page and the
// webhook BOTH run fulfillment (docs/stripe-checkout-webhooks.md §2 — the
// success-page redirect is not reliable, the webhook is authoritative); both
// are idempotent, so instant UX and eventual delivery never double-grant.

import { eq } from 'drizzle-orm';

import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { organizations } from '$lib/server/db/schema';
import { bundleById, priceIdFor, type CreditBundle } from '$lib/server/stripe/bundles';
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
	const customer = await getStripe().customers.create({
		name: user.orgName,
		email: user.email,
		metadata: { org_id: orgId }
	});
	await db
		.update(organizations)
		.set({ stripeCustomerId: customer.id })
		.where(eq(organizations.id, orgId));
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
		success_url: `${appUrl}/usage/success?session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${appUrl}/usage`
	});
	if (!session.url) throw new Error(`stripe returned no Checkout URL for session ${session.id}`);
	return session.url;
}
