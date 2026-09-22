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
import { expectedBundlePriceCents } from '$lib/credit-pricing';
import { assertCreditsPurchasable, UNMETERED_CREDIT_PURCHASE_ERROR } from './ledger';
import { isActiveSubscriptionStatus, planPriceEnv, validatePlanPrice, type PaidPlan } from './plans';
import { getStripe } from '$lib/server/stripe/client';
import { requireOrgRole } from '$lib/server/ownership';
import type { SessionUser } from '$lib/server/session';

const HOSTED_PLAN_EXISTS_ERROR = 'organization already has a hosted subscription';
const ACTIVE_HOSTED_PLAN_ERROR = 'organization already has an active hosted subscription';
const LIFETIME_PLAN_EXISTS_ERROR = 'organization already has the lifetime plan';
const LIFETIME_SOLD_OUT_ERROR = 'lifetime plan is sold out';

/**
 * The metadata `product` value (and checkout-attempt product) for the
 * operator test checkout driven by STRIPE_TEST_PRODUCT. The webhook's
 * fulfillment dispatches on this value — keep it in sync with webhooks.ts.
 */
export const TEST_CHECKOUT_PRODUCT = 'test';

/**
 * User-facing text for KNOWN business rejections of checkout creation —
 * the buyer did nothing wrong and retrying will never help, so the answer
 * is a specific 400, not the generic defect message. Internal strings are
 * whitelisted by identity: anything unmapped (DB internals, env names,
 * Stripe ids) stays a generic 500 per the no-leak rule.
 */
export function checkoutRejectionMessage(error: unknown): string | null {
	if (!(error instanceof Error)) return null;
	switch (error.message) {
		case HOSTED_PLAN_EXISTS_ERROR:
			return 'Your organization already has an active hosted subscription — manage it via the customer portal below.';
		case ACTIVE_HOSTED_PLAN_ERROR:
			return 'Cancel your hosted subscription before buying the lifetime plan — manage it via the customer portal below.';
		case LIFETIME_PLAN_EXISTS_ERROR:
			return 'Your organization already has the lifetime plan.';
		case LIFETIME_SOLD_OUT_ERROR:
			return 'The lifetime plan is sold out — all 1,000 copies are claimed.';
		case UNMETERED_CREDIT_PURCHASE_ERROR:
			return 'Your lifetime plan includes unlimited moderated comments — credit purchases are not needed.';
		default:
			break;
	}
	// STRIPE_TEST_PRODUCT resolution failures are operator-facing rejections:
	// retrying can never fix a bad test-product config, so the action answers
	// 400 with a sanitized reason — the env name and Stripe detail stay in
	// the server log. The missing-var case is a crafted-POST defect (the
	// button never renders without it) and keeps its generic 500.
	if (error.message !== 'STRIPE_TEST_PRODUCT is not configured' && error.message.startsWith('STRIPE_TEST_PRODUCT')) {
		return 'The test checkout is misconfigured on this deployment — the exact reason is in the server log.';
	}
	// Same rule for the bundle catalog: validateBundlePrice/priceIdFor errors
	// on a CONFIGURED STRIPE_PRICE_CREDITS_* var are permanent deployment
	// faults, not transient failures — the advertised button would otherwise
	// fail forever behind "please try again" (codex). The missing-var case
	// stays a 500: the button only renders for configured bundles.
	if (!error.message.endsWith(' is not configured') && error.message.startsWith('STRIPE_PRICE_CREDITS_')) {
		return 'This credit bundle is misconfigured on this deployment — the exact reason is in the server log.';
	}
	return null;
}

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
 * APP_URL must be an absolute http(s) URL — checked BEFORE any durable
 * checkout state exists: a malformed value would otherwise surface inside
 * new URL() only after the attempt row (and possibly the Stripe customer)
 * was already persisted, and a non-http(s) scheme could reach Stripe's
 * redirect fields (coderabbit/cubic). Same rule as the card-portal action.
 */
function checkoutAppUrl(): URL {
	const raw = env.APP_URL;
	if (!raw) throw new Error('APP_URL is not configured');
	const appUrl = URL.parse(raw);
	if (!appUrl || (appUrl.protocol !== 'http:' && appUrl.protocol !== 'https:')) {
		throw new Error('APP_URL is not configured as a valid absolute http(s) URL');
	}
	return appUrl;
}

function checkoutRedirectUrls(appUrl: URL): { success_url: string; cancel_url: string } {
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
	const appUrl = checkoutAppUrl();
	// Unlimited plans never buy credits — rejected before an attempt row is
	// planted (the lifetime org's scoring is already free; MOD-35).
	await assertCreditsPurchasable(orgId);
	// The configured Price is validated BEFORE the attempt row: a bundle
	// Price that is inactive, non-USD, recurring, or charges a different
	// amount than the advertised discount would either fail downstream or —
	// worse — charge the buyer an amount the button never promised (codex).
	// Same catalog-validation rule as the plan checkout's validatePlanPrice.
	const priceId = priceIdFor(bundle);
	validateBundlePrice(bundle, await getStripe().prices.retrieve(priceId));
	return createCheckoutAttempt(orgId, bundle.id, attemptId, async (idempotencyKey) => {
		const customer = await getOrCreateStripeCustomer(orgId, user);
		return getStripe().checkout.sessions.create({
			mode: 'payment',
			line_items: [{ price: priceId, quantity: 1 }],
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
	const org = await db.select({ plan: organizations.plan, stripeSubscriptionId: organizations.stripeSubscriptionId, stripeSubscriptionStatus: organizations.stripeSubscriptionStatus, stripeSubscriptionCancelAtPeriodEnd: organizations.stripeSubscriptionCancelAtPeriodEnd }).from(organizations).where(eq(organizations.id, orgId)).get();
	if (!org) throw new Error(`org not found: ${orgId}`);
	const hasActiveHosted = Boolean(org.stripeSubscriptionId && isActiveSubscriptionStatus(org.stripeSubscriptionStatus));
	const lifetime = await db.select({ id: stripeLifetimeEntitlements.id }).from(stripeLifetimeEntitlements).where(and(eq(stripeLifetimeEntitlements.orgId, orgId), eq(stripeLifetimeEntitlements.status, 'active'))).get();
	if (plan === 'hosted') {
		// A cancel-pending sub still blocks a SECOND hosted subscription —
		// staying on hosted means resuming in the portal, not minting a
		// duplicate the webhook would have to tear down and refund.
		if (hasActiveHosted) throw new Error(HOSTED_PLAN_EXISTS_ERROR);
		if (org.plan === 'lifetime' || lifetime) throw new Error(LIFETIME_PLAN_EXISTS_ERROR);
		return;
	}
	// The lifetime gate is looser: a subscription already scheduled to end
	// (cancel_at_period_end or the portal's cancel_at timestamp — both land
	// in stripeSubscriptionCancelAtPeriodEnd) cannot renew, so buying now is
	// safe. Fulfillment re-verifies against the LIVE subscription in case a
	// resume hasn't webhoked yet, and a later resume is re-canceled by the
	// subscription-event handler.
	if (hasActiveHosted && org.stripeSubscriptionCancelAtPeriodEnd !== 1) throw new Error(ACTIVE_HOSTED_PLAN_ERROR);
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
 * The configured bundle Price must charge exactly the catalog amount the
 * discount label is derived from — anything else means the button's
 * advertised cut is a lie about what the buyer pays (codex). Errors name
 * the env var, not the Stripe id, matching configuredPlanPriceId.
 */
function validateBundlePrice(bundle: CreditBundle, price: { active?: unknown; currency?: unknown; type?: unknown; unit_amount?: unknown }): void {
	if (price.active !== true) throw new Error(`${bundle.priceEnv} Stripe Price is inactive`);
	if (price.currency !== 'usd') throw new Error(`${bundle.priceEnv} Stripe Price must be USD`);
	if (price.type !== 'one_time') throw new Error(`${bundle.priceEnv} Stripe Price must be one-time`);
	const expectedCents = expectedBundlePriceCents(bundle.credits);
	if (price.unit_amount !== expectedCents) {
		throw new Error(`${bundle.priceEnv} Stripe Price must charge ${expectedCents} cents — the ${bundle.label} bundle advertises its discount against that catalog amount`);
	}
}

/**
 * Creates a Checkout Session for one of the hosted products. The application
 * owns the catalog: Stripe's configured Price is retrieved and checked before
 * any Checkout session is created, and fulfillment rechecks the metadata and
 * mode in the webhook.
 */
export async function createPlanCheckout(orgId: string, user: SessionUser, plan: PaidPlan, attemptId?: string): Promise<string> {
	requireOrgRole(user, 'owner');
	const appUrl = checkoutAppUrl();
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

/**
 * Resolves STRIPE_TEST_PRODUCT to a Stripe Price id. The var accepts a Price
 * id directly (`price_...`) or a Product id (`prod_...`) — the name says
 * product because that is what the dashboard hands the operator, but Checkout
 * needs a Price. A product resolves through its `default_price`; without one
 * it must have exactly one active price, or the configuration is ambiguous
 * and fails loudly. The resolved price is validated (active, one-time —
 * the test checkout runs in payment mode) before any session is created (I2).
 */
async function testProductPriceId(): Promise<string> {
	const configured = env.STRIPE_TEST_PRODUCT;
	if (!configured) throw new Error('STRIPE_TEST_PRODUCT is not configured');
	try {
		let priceId = configured;
		if (configured.startsWith('prod_')) {
			const product = await getStripe().products.retrieve(configured);
			const defaultPrice = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
			if (defaultPrice) {
				priceId = defaultPrice;
			} else {
				const prices = await getStripe().prices.list({ product: configured, active: true, limit: 2 });
				if (prices.data.length !== 1) {
					throw new Error(`STRIPE_TEST_PRODUCT product has no default price and ${prices.data.length} active prices — set a default price or configure the Price id directly`);
				}
				priceId = prices.data[0].id;
			}
		}
		if (!priceId.startsWith('price_')) throw new Error('STRIPE_TEST_PRODUCT must be a Stripe Product (prod_...) or Price (price_...) id');
		const price = await getStripe().prices.retrieve(priceId);
		if (price.active !== true) throw new Error('STRIPE_TEST_PRODUCT resolves to an inactive Stripe Price');
		if (price.type !== 'one_time') throw new Error('STRIPE_TEST_PRODUCT resolves to a recurring Stripe Price — the test checkout runs in payment mode');
		// A zero-amount (or amount-less, e.g. custom_unit_amount) Price completes
		// Checkout as no_payment_required — fulfillCheckout rejects those, so the
		// smoke test would end without ever touching the paid pipeline it exists
		// to verify (codex/cubic). The test must charge real money.
		if (typeof price.unit_amount !== 'number' || price.unit_amount <= 0) {
			throw new Error('STRIPE_TEST_PRODUCT resolves to a zero-priced Stripe Price — the test checkout must charge a real payment');
		}
		return priceId;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith('STRIPE_TEST_PRODUCT')) throw error;
		// A prod_/price_ id that does not exist in the active Stripe mode is a
		// permanent misconfiguration, not a transient provider failure — it
		// must carry the STRIPE_TEST_PRODUCT prefix so the action maps it to
		// the sanitized 400 instead of a retryable generic error (codex).
		if ((error as { code?: unknown })?.code === 'resource_missing') {
			throw new Error('STRIPE_TEST_PRODUCT references a Stripe Product or Price that does not exist in this mode');
		}
		throw error;
	}
}

/**
 * Creates a Checkout Session for the operator test product
 * (STRIPE_TEST_PRODUCT) — a smoke test for a deployment's billing pipeline:
 * the attempt row, Checkout Session, webhook fulfillment, and ledger grant
 * are all real, and a paid test checkout grants one credit. Deliberately NOT
 * gated by assertCreditsPurchasable — on an unmetered org the paid test
 * checkout exercises the ungrantable→refund path, which is also worth
 * verifying. Owner-only like every purchase.
 */
export async function createTestCheckout(orgId: string, user: SessionUser, attemptId?: string): Promise<string> {
	requireOrgRole(user, 'owner');
	const appUrl = checkoutAppUrl();
	// Config check BEFORE the attempt row: a crafted POST without the env var
	// must fail without planting durable state (env validation at handler
	// start — the review rules).
	if (!env.STRIPE_TEST_PRODUCT) throw new Error('STRIPE_TEST_PRODUCT is not configured');
	// The Stripe price resolves BEFORE the attempt row too — a failed lookup
	// or invalid configuration must not leave a durable pending attempt that
	// no session will ever claim (cubic/codeant).
	const priceId = await testProductPriceId();
	return createCheckoutAttempt(orgId, TEST_CHECKOUT_PRODUCT, attemptId, async (idempotencyKey) => {
		const customer = await getOrCreateStripeCustomer(orgId, user);
		return getStripe().checkout.sessions.create(
			{
				mode: 'payment',
				line_items: [{ price: priceId, quantity: 1 }],
				customer,
				client_reference_id: orgId,
				metadata: { org_id: orgId, product: TEST_CHECKOUT_PRODUCT },
				payment_intent_data: { setup_future_usage: 'off_session' },
				...checkoutRedirectUrls(appUrl)
			},
			{ idempotencyKey }
		);
	});
}
