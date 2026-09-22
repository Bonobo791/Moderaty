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

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { TEST_OWNER, postForm, setupTestDb, testDb } from '$lib/server/testdb';
import { mercadoPagoCheckoutAttempts, organizations, stripeCheckoutAttempts, stripeLifetimeSlots } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/session';
import { TEST_CHECKOUT_OPERATOR_EMAIL } from '$lib/server/billing/checkout';
import { applyLedgerDelta, consumeCredit } from '$lib/server/billing/ledger';
import { claimLifetimeSlot } from '$lib/server/billing/entitlements';
import { LIFETIME_SLOT_LIMIT } from '$lib/server/billing/plans';
import { AUTO_TOPUP_CONSENT_TEXT, LEGAL_VERSION } from '$lib/server/legal';
import { configuredBundles } from '$lib/server/stripe/bundles';

const mocks = vi.hoisted(() => ({
	sessionsCreate: vi.fn(),
	customersCreate: vi.fn(), pricesRetrieve: vi.fn(), billingPortalSessionsCreate: vi.fn(),
	paymentMethodsRetrieve: vi.fn()
}));

vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => ({
		checkout: { sessions: { create: mocks.sessionsCreate } },
		prices: { retrieve: mocks.pricesRetrieve },
		customers: { create: mocks.customersCreate },
		billingPortal: { sessions: { create: mocks.billingPortalSessionsCreate } },
		paymentMethods: { retrieve: mocks.paymentMethodsRetrieve }
	})
}));
vi.mock('$env/dynamic/private', () => ({
	env: {
		APP_URL: 'http://localhost:5173',
		ENCRYPTION_KEY: 'test-encryption-key',
		STRIPE_PRICE_CREDITS_100: 'price_100',
		STRIPE_PRICE_CREDITS_500: 'price_500',
		STRIPE_PRICE_CREDITS_2000: 'price_2000',
		STRIPE_PRICE_HOSTED_MONTHLY: 'price_hosted',
		STRIPE_PRICE_LIFETIME: 'price_lifetime',
		STRIPE_TEST_PRODUCT: 'price_test'
	}
}));

import { env } from '$env/dynamic/private';

import { render } from 'svelte/server';

import Page from './+page.svelte';
import { actions, load } from './+page.server';

setupTestDb(['organizations', 'credit_transactions', 'stripe_events', 'stripe_checkout_attempts', 'mercado_pago_checkout_attempts', 'stripe_lifetime_entitlements', 'stripe_lifetime_slots', 'stripe_pending_reversals', 'stripe_dispute_reversals']);

const OWNER = TEST_OWNER;
// The test checkout is gated to the operator account — TEST_OWNER's email is
// deliberately NOT it, so OPERATOR is a distinct fixture and every
// non-operator assertion below exercises a real owner who is not allowed.
const OPERATOR: SessionUser = { ...TEST_OWNER, email: TEST_CHECKOUT_OPERATOR_EMAIL };

async function seedOrg(overrides: Record<string, unknown> = {}): Promise<void> {
	await testDb().db.insert(organizations).values({
		id: 'org-1',
		name: 'One',
		creditsRemaining: 0,
		...overrides
	});
}

function buy(bundle: string, user: SessionUser | null = OWNER) {
	return actions.buy({ request: postForm({ bundle }), locals: { user } } as never);
}

function buyPlan(plan: string, user: SessionUser | null = OWNER) {
	return actions.buyPlan({ request: postForm({ plan }), locals: { user } } as never);
}

function buyTest(user: SessionUser | null = OPERATOR) {
	return actions.buyTest({ request: postForm({}), locals: { user } } as never);
}

function setAutoTopup(fields: Record<string, string>, user: SessionUser | null = OWNER) {
	return actions.setAutoTopup({ request: postForm(fields), locals: { user } } as never);
}

function manageCards(user: SessionUser | null = OWNER) {
	return actions.manageCards({ locals: { user } } as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.sessionsCreate.mockResolvedValue({ id: 'cs_new', url: 'https://checkout.stripe.com/pay/test_123' });
	mocks.customersCreate.mockResolvedValue({ id: 'cus_new' });
	// Bundle Prices must charge the shared catalog amount — the checkout
	// validates unit_amount against expectedBundlePriceCents before any
	// session exists. price_lifetime stays at its catalog 4900.
	const bundleCents: Record<string, number> = { price_100: 500, price_500: 2040, price_2000: 6465, price_lifetime: 4900, price_test: 100 };
	mocks.pricesRetrieve.mockImplementation(async (id: string) => id === 'price_hosted' ? { id, active: true, currency: 'usd', type: 'recurring', unit_amount: 500, recurring: { interval: 'month', interval_count: 1 } } : { id, active: true, currency: 'usd', type: 'one_time', unit_amount: bundleCents[id] ?? 100 });
	mocks.paymentMethodsRetrieve.mockResolvedValue({ id: 'pm_1', type: 'card', card: { brand: 'visa', last4: '4242' } });
	// The env mock object is shared: a test that unsets STRIPE_TEST_PRODUCT
	// must not leak that into the next test.
	env.STRIPE_TEST_PRODUCT = 'price_test';
});

describe('usage load', () => {
	// The render tests all share one data shape — the full load payload a
	// healthy page receives; each test spreads it and overrides what varies.
	function usagePageData() {
		return {
			maintenance: false,
			user: OWNER,
			summary: { remaining: 0, usedThisMonth: 0, usedLifetime: 0 },
			metered: false,
			history: [],
			bundles: [],
			mercadoPagoBundles: [],
			autoTopup: { enabled: false, threshold: 100, state: 'idle', failures: 0, lastAttemptAt: null, hasCard: false, card: null },
			autoTopupConsentText: 'consent',
			stripeConfigured: true,
			plans: { hosted: true, lifetime: true },
			testProduct: true
		};
	}

	test('a database failure mid-load degrades to the maintenance payload and logs loudly', async () => {
		// The layout renders the maintenance overlay for this shape — the page
		// must never surface SvelteKit's unstyled 500 for a mid-load DB error.
		await seedOrg({ creditsRemaining: 120, autoTopupEnabled: 1, autoTopupThreshold: 100, autoTopupState: 'idle', stripeDefaultPmId: 'pm_1' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const client = testDb().client;
		const originalExecute = client.execute.bind(client);
		client.execute = (() => Promise.reject(new Error('hrana 502: connect to upstream failed'))) as never;
		let data: Record<string, unknown>;
		try {
			data = (await load({ locals: { user: OWNER } } as never)) as Record<string, unknown>;
		} finally {
			client.execute = originalExecute;
		}
		expect(data).toMatchObject({ maintenance: true, user: null, summary: null });
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('usage: load failed'));
		errorSpy.mockRestore();
	});

	test('does not mark a NULL-balance unlimited org as out of credits', async () => {
		await seedOrg({ creditsRemaining: null });
		const data = (await load({ locals: { user: OWNER } } as never)) as { metered: boolean; summary: { remaining: number } };
		expect(data.metered).toBe(false);
		expect(data.summary.remaining).toBe(0);
	});

	test('reports the org balance, consumption, bundles and auto top-up state', async () => {
		await seedOrg({ creditsRemaining: 120, autoTopupEnabled: 1, autoTopupThreshold: 100, autoTopupState: 'idle', stripeDefaultPmId: 'pm_1' });
		await applyLedgerDelta(testDb().db as never, { orgId: 'org-1', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1' });
		await consumeCredit(testDb().db as never, 'org-1', 'comment-1');

		const data = (await load({ locals: { user: OWNER } } as never)) as {
			summary: { remaining: number; usedLifetime: number; usedThisMonth: number };
			bundles: { id: string }[];
			autoTopup: { enabled: boolean; threshold: number; state: string; hasCard: boolean };
			history: unknown[];
		};

		expect(data.summary).toMatchObject({ remaining: 619, usedLifetime: 1, usedThisMonth: 1 });
		expect(data.bundles.map((bundle) => bundle.id)).toEqual(['credits_100', 'credits_500', 'credits_2000']);
		expect(data.autoTopup).toMatchObject({ enabled: true, threshold: 100, state: 'idle', hasCard: true });
		expect(data.history).toHaveLength(2);
		// The history contract: every row carries the full record — id, delta,
		// reason, refType, refId (coderabbit: a loader returning garbage rows
		// must fail this test, not just the count).
		const history = data.history as { id: number; delta: number; reason: string; refType: string; refId: string }[];
		const purchase = history.find((row) => row.reason === 'purchase');
		expect(purchase).toMatchObject({ delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1' });
		expect(purchase?.id).toEqual(expect.any(Number));
		const consume = history.find((row) => row.reason === 'consume');
		expect(consume).toMatchObject({ delta: -1, reason: 'consume', refType: 'comment', refId: 'comment-1' });
		expect(consume?.id).toEqual(expect.any(Number));
	});

	test('resolves the saved card brand/last4 live from Stripe for the Cards section', async () => {
		// The card display is driven by the stored default PM pointer, resolved
		// live so a card swapped in the Stripe portal shows correctly without a
		// webhook round-trip.
		await seedOrg({ stripeDefaultPmId: 'pm_1' });
		const data = (await load({ locals: { user: OWNER } } as never)) as { autoTopup: { hasCard: boolean; card: { label: string } | null } };
		expect(data.autoTopup.hasCard).toBe(true);
		expect(data.autoTopup.card?.label).toBe('Visa •••• 4242');
		expect(mocks.paymentMethodsRetrieve).toHaveBeenCalledWith('pm_1');
	});

	test('a payment-method fetch failure keeps the card flag and says details are unavailable — never a maintenance page', async () => {
		// The pointer stays authoritative (hasCard); only the display details
		// degrade. The failure is loud in the server log and visible in copy.
		await seedOrg({ stripeDefaultPmId: 'pm_gone' });
		mocks.paymentMethodsRetrieve.mockRejectedValue(new Error('resource_missing'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const data = (await load({ locals: { user: OWNER } } as never)) as { maintenance: boolean; autoTopup: { hasCard: boolean; card: unknown } };
			expect(data.maintenance).toBe(false);
			expect(data.autoTopup.hasCard).toBe(true);
			expect(data.autoTopup.card).toBeNull();
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('pm_gone'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('no saved card pointer means no Stripe call at all', async () => {
		await seedOrg();
		const data = (await load({ locals: { user: OWNER } } as never)) as { autoTopup: { hasCard: boolean; card: unknown } };
		expect(data.autoTopup.hasCard).toBe(false);
		expect(data.autoTopup.card).toBeNull();
		expect(mocks.paymentMethodsRetrieve).not.toHaveBeenCalled();
	});

	test('load surfaces the remaining lifetime slot count', async () => {
		await seedOrg();
		const fresh = (await load({ locals: { user: OWNER } } as never)) as { lifetimeSlots: number };
		expect(fresh.lifetimeSlots).toBe(LIFETIME_SLOT_LIMIT);

		await claimLifetimeSlot({ orgId: 'org-1', checkoutSessionId: 'cs-1', paymentIntentId: 'pi-1', chargeId: 'ch-1' });
		const after = (await load({ locals: { user: OWNER } } as never)) as { lifetimeSlots: number };
		expect(after.lifetimeSlots).toBe(LIFETIME_SLOT_LIMIT - 1);
	});

	test('a missing organization is a loud 500, never a maintenance payload', async () => {
		// The user's session points at an org row that no longer exists — an
		// account-integrity failure that must reach the user with the support
		// instruction, not masquerade as a database outage (coderabbit).
		await expect(load({ locals: { user: OWNER } } as never)).rejects.toMatchObject({ status: 500 });
	});

	test('a mid-load maintenance payload renders the maintenance state, never zero-credit stats', async () => {
		// The layout overlay only triggers on LAYOUT data; when the layout was
		// healthy but the usage queries failed mid-load, the page must render
		// its own maintenance state instead of a misleading all-zero page
		// (codex 6145, I12).
		const { body } = render(Page, {
			props: {
				data: {
					maintenance: true,
					user: null,
					summary: null,
					history: [],
					bundles: [],
					autoTopup: null,
					autoTopupConsentText: 'consent'
				},
				form: {}
			} as never
		});
		expect(body).toContain('Moderaty is temporarily unable to reach its database');
		expect(body).not.toContain('Credits left');
	});

	test('a lifetime org sees no credit purchase or auto top-up forms — with an explanation, not silence', async () => {
		// Unlimited scoring makes credit bundles and auto top-up useless, so
		// the cards are replaced by an explanatory line (I12: never silently
		// different). A metered org renders them normally.
		const base = { ...usagePageData(), bundles: [{ id: 'credits_100', label: '100 credits' }], mercadoPagoBundles: [{ id: 'credits_100', label: '100 credits', amountCents: 990 }] };
		const lifetime = render(Page, {
			props: { data: { ...base, billing: { plan: 'lifetime', subscriptionStatus: null, periodEnd: null } }, form: null } as never
		}).body;
		expect(lifetime).not.toContain('action="?/buy"');
		expect(lifetime).not.toContain('action="?/buyMercadoPago"');
		expect(lifetime).not.toContain('action="?/setAutoTopup"');
		expect(lifetime).toContain('unlimited moderated comments');

		const metered = render(Page, {
			props: { data: { ...base, billing: { plan: null, subscriptionStatus: null, periodEnd: null } }, form: null } as never
		}).body;
		expect(metered).toContain('action="?/buy"');
		expect(metered).toContain('action="?/buyMercadoPago"');
		expect(metered).toContain('action="?/setAutoTopup"');

		// A stale enabled flag (enabled before the upgrade) must be
		// DISABLE-able from the page — but only disable: no enable checkbox,
		// threshold field, or consent the server would reject (review).
		const stale = render(Page, {
			props: { data: { ...base, billing: { plan: 'lifetime', subscriptionStatus: null, periodEnd: null }, autoTopup: { ...base.autoTopup, enabled: true } }, form: null } as never
		}).body;
		expect(stale).toContain('action="?/setAutoTopup"');
		expect(stale).toContain('Disable automatic top-up');
		expect(stale).not.toContain('name="enabled"');
		expect(stale).not.toContain('name="threshold"');
		expect(stale).not.toContain('Enable auto top-up');
	});

	test('the buy credits card advertises the larger bundles\' bulk discount', () => {
		// The percentage lives in the CREDIT_BUNDLES catalog — rendering the
		// real configured bundles pins both the values and the button copy.
		// Svelte's {#if} anchors interleave HTML comments between text nodes,
		// so assert the fragments in order rather than stripping comments
		// (CodeQL flags comment-stripping regexes as incomplete sanitization).
		const body = render(Page, {
			props: { data: { ...usagePageData(), bundles: configuredBundles() }, form: null } as never
		}).body;
		expect(body).toMatch(/Buy 100 comments[\s\S]*?<\/button>/);
		expect(body).toMatch(/Buy 500 comments[\s\S]*?· 18% off[\s\S]*?<\/button>/);
		expect(body).toMatch(/Buy 2,000 comments[\s\S]*?· 35% off[\s\S]*?<\/button>/);
	});

	test('the Plans card shows the claimed count, a sold-out state at zero, and an owned state for lifetime orgs', async () => {
		// The deal is 1,000 slots: buyers see how many are gone, nobody can
		// click a dead buy button once sold out, and a lifetime org sees its
		// plan instead of a second buy form (I12: explicit states, never a
		// button that only fails at checkout).
		const base = { ...usagePageData(), plans: { hosted: false, lifetime: true } };

		const available = render(Page, {
			props: { data: { ...base, lifetimeSlots: 997, billing: { plan: null, subscriptionStatus: null, periodEnd: null } }, form: null } as never
		}).body;
		expect(available).toContain('action="?/buyPlan"');
		expect(available).toContain('3 of 1,000 claimed');
		// BYOK is mandatory on lifetime (Terms §6.1(c)) — an offer that says
		// "unlimited comments" without naming the required OpenAI key hides a
		// material ongoing cost until after purchase (codex P1). Disclose it
		// on the purchase surface, not just post-sale.
		expect(available).toMatch(/own OpenAI API key/i);

		const soldOut = render(Page, {
			props: { data: { ...base, lifetimeSlots: 0, billing: { plan: null, subscriptionStatus: null, periodEnd: null } }, form: null } as never
		}).body;
		expect(soldOut).not.toContain('action="?/buyPlan"');
		expect(soldOut).toContain('sold out');

		const owned = render(Page, {
			// plans.hosted configured too — a lifetime org must not get a hosted
			// buy form the server would only reject as an overlap (review).
			props: { data: { ...base, plans: { hosted: true, lifetime: true }, lifetimeSlots: 0, billing: { plan: 'lifetime', subscriptionStatus: null, periodEnd: null } }, form: null } as never
		}).body;
		expect(owned).not.toContain('action="?/buyPlan"');
		expect(owned).toContain('lifetime plan');
	});

	test('a lifetime org never gets a period end on the plan line — a live hosted subscription shows separately', async () => {
		// After a cancel→lifetime upgrade the subscription keeps its paid
		// window, but "period ends" belongs to the SUBSCRIPTION — the lifetime
		// plan has no period. The live sub renders as its own line so the
		// user can see it winding down.
		const base = { ...usagePageData(), summary: { remaining: 200, usedThisMonth: 0, usedLifetime: 0 }, hasOpenAiKey: true };
		const windingDown = render(Page, {
			props: { data: { ...base, billing: { plan: 'lifetime', subscriptionStatus: 'active', periodEnd: '2026-10-19T22:46:39.000Z', cancelAtPeriodEnd: true, subscriptionLive: true } }, form: null } as never
		}).body;
		expect(windingDown).toContain('Current plan: <strong>lifetime</strong>');
		expect(windingDown).not.toContain('period ends');
		expect(windingDown).toContain('Hosted subscription');
		expect(windingDown).toContain(new Date('2026-10-19T22:46:39.000Z').toLocaleDateString());

		// Once the subscription is terminal there is nothing to show.
		const ended = render(Page, {
			props: { data: { ...base, billing: { plan: 'lifetime', subscriptionStatus: 'canceled', periodEnd: '2026-10-19T22:46:39.000Z', cancelAtPeriodEnd: false, subscriptionLive: false } }, form: null } as never
		}).body;
		expect(ended).not.toContain('Hosted subscription');
	});

	test('a lifetime org sees its required BYOK state — a loud missing-key warning or the saved-key status', async () => {
		// BYOK is not optional on lifetime: no stored key means scoring cannot
		// run (resolveOpenAiKey withholds the deployment key, comments queue).
		// The plan card must say so loudly — not "optional" — and point at the
		// Team page where the owner-only form lives. Metered orgs see neither.
		const base = usagePageData();
		const missing = render(Page, {
			props: { data: { ...base, hasOpenAiKey: false, billing: { plan: 'lifetime', subscriptionStatus: null, periodEnd: null } }, form: null } as never
		}).body;
		expect(missing).toContain('href="/org"');
		expect(missing).toContain('OpenAI API key');
		expect(missing).toContain('error-box');
		expect(missing).toContain('review queue');
		expect(missing).not.toContain('Optional');

		const saved = render(Page, {
			props: { data: { ...base, hasOpenAiKey: true, billing: { plan: 'lifetime', subscriptionStatus: null, periodEnd: null } }, form: null } as never
		}).body;
		expect(saved).toContain('OpenAI API key');
		expect(saved).toContain('href="/org"');
		expect(saved).not.toContain('error-box');

		const hosted = render(Page, {
			props: { data: { ...base, hasOpenAiKey: false, billing: { plan: 'hosted', subscriptionStatus: 'active', periodEnd: '2026-10-19T00:00:00.000Z' } }, form: null } as never
		}).body;
		expect(hosted).not.toContain('OpenAI API key');
	});

	test('load exposes hasOpenAiKey as a boolean — never the key or its ciphertext', async () => {
		await seedOrg();
		const unset = (await load({ locals: { user: OWNER } } as never)) as { hasOpenAiKey: boolean };
		expect(unset.hasOpenAiKey).toBe(false);

		await testDb().db.update(organizations).set({ openaiKeyEnc: 'ENC:sentinel-ciphertext' }).where(eq(organizations.id, 'org-1'));
		const view = (await load({ locals: { user: OWNER } } as never)) as Record<string, unknown>;
		expect(view.hasOpenAiKey).toBe(true);
		// The serialized payload must carry only the boolean — never the
		// stored ciphertext, which a leak would hand straight to the client.
		expect(JSON.stringify(view)).not.toContain('ENC:sentinel-ciphertext');
	});

	test('a lifetime org whose stored key no longer decrypts sees the missing-key warning, not "scoring active"', async () => {
		// Truthiness is not usability: a corrupt ciphertext (key rotation,
		// truncation) still passes Boolean(openaiKeyEnc) — the page would
		// claim scoring runs on the saved key while resolveOpenAiKey queues
		// every comment (codex P2). The flag must reflect a DECRYPTABLE key.
		await seedOrg({ plan: 'lifetime', openaiKeyEnc: 'ENC:not-real-ciphertext' });
		const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const view = (await load({ locals: { user: OWNER } } as never)) as { hasOpenAiKey: boolean };
			expect(view.hasOpenAiKey).toBe(false);
		} finally {
			spy.mockRestore();
		}
		// And a decryptable key still reports true — the positive leg.
		const { encrypt } = await import('$lib/server/crypto');
		await testDb().db.update(organizations).set({ openaiKeyEnc: encrypt('sk-live-usable') }).where(eq(organizations.id, 'org-1'));
		const usable = (await load({ locals: { user: OWNER } } as never)) as { hasOpenAiKey: boolean };
		expect(usable.hasOpenAiKey).toBe(true);
	});

	test('a hosted org sees Manage subscription instead of dead buy buttons', async () => {
		// One live subscription per org: the "Start hosted" form only ever
		// 400s for a subscribed org, and the lifetime form only ever tells
		// them to cancel first — replace both with the portal button that can
		// actually manage the subscription (I12: no button that only fails).
		const base = { ...usagePageData(), billing: { plan: 'hosted', subscriptionStatus: 'active', periodEnd: '2026-10-19T00:00:00.000Z' } };
		const body = render(Page, { props: { data: base, form: null } as never }).body;
		expect(body).toContain('Manage subscription');
		expect(body).toContain('action="?/manageCards"');
		expect(body).not.toContain('value="hosted"');
		expect(body).not.toContain('value="lifetime"');
		// The cancel-first hint keeps the lifetime path discoverable.
		expect(body).toContain('cancel');
	});

	test('load exposes the pending-cancellation flag on billing', async () => {
		await seedOrg({ plan: 'hosted', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active', stripeSubscriptionCancelAtPeriodEnd: 1, stripeSubscriptionPeriodEnd: '2026-10-19T00:00:00.000Z' });
		const data = (await load({ locals: { user: OWNER } } as never)) as { billing: { cancelAtPeriodEnd: boolean; periodEnd: string } };
		expect(data.billing.cancelAtPeriodEnd).toBe(true);
		expect(data.billing.periodEnd).toBe('2026-10-19T00:00:00.000Z');
	});

	test('a cancel-pending hosted org sees the pending notice and the lifetime buy form', async () => {
		// The cancel is already scheduled — the page must SAY so (silence is
		// the bug: the canceled sub looked identical to a live one) and the
		// lifetime offer unlocks immediately instead of after period end.
		const base = { ...usagePageData(), lifetimeSlots: 997, billing: { plan: 'hosted', subscriptionStatus: 'active', periodEnd: '2026-10-19T00:00:00.000Z', cancelAtPeriodEnd: true } };
		const body = render(Page, { props: { data: base, form: null } as never }).body;
		expect(body).toContain('Manage subscription');
		expect(body).toContain('subscription is canceled');
		expect(body).toContain('action="?/buyPlan"');
		expect(body).toContain('value="lifetime"');
		// A second hosted subscription stays blocked — resume via the portal.
		expect(body).not.toContain('value="hosted"');
	});

	test('load reports the test product only for the operator and only while STRIPE_TEST_PRODUCT is set', async () => {
		await seedOrg();
		// The operator sees the flag with the var configured…
		expect(((await load({ locals: { user: OPERATOR } } as never)) as { testProduct: boolean }).testProduct).toBe(true);
		// …and a regular owner — the production bug this gate fixes — never
		// does, even on a deployment where the var is set.
		expect(((await load({ locals: { user: OWNER } } as never)) as { testProduct: boolean }).testProduct).toBe(false);
		(env as Record<string, string | undefined>).STRIPE_TEST_PRODUCT = undefined;
		try {
			expect(((await load({ locals: { user: OPERATOR } } as never)) as { testProduct: boolean }).testProduct).toBe(false);
		} finally {
			env.STRIPE_TEST_PRODUCT = 'price_test';
		}
	});

	test('the test checkout card renders only when the test product and Stripe are both configured', async () => {
		// The card is the operator's smoke-test entry point — hidden without
		// STRIPE_TEST_PRODUCT, and never a permanently failing button when
		// Stripe itself is unconfigured (the codex P2 rule on dead buttons).
		const configured = render(Page, { props: { data: usagePageData(), form: null } as never }).body;
		expect(configured).toContain('action="?/buyTest"');
		expect(configured).toContain('Run test purchase');

		const noProduct = render(Page, { props: { data: { ...usagePageData(), testProduct: false }, form: null } as never }).body;
		expect(noProduct).not.toContain('?/buyTest');

		const noStripe = render(Page, { props: { data: { ...usagePageData(), stripeConfigured: false }, form: null } as never }).body;
		expect(noStripe).not.toContain('?/buyTest');
	});

	test('the test checkout card discloses that a paid test saves the card and can disable auto top-up', async () => {
		// codex/coderabbit: a successful test payment runs the shared
		// savePaymentMethod path — a different card becomes the saved card and
		// disables auto top-up until re-consented. That side effect must be
		// disclosed BEFORE the owner clicks, not discovered after.
		// Fragments must be contiguous in the rendered markup — the copy wraps
		// across source lines.
		const body = render(Page, { props: { data: usagePageData(), form: null } as never }).body;
		expect(body).toContain('the payment method is saved for');
		expect(body).toContain('automatic top-up is disabled');
		expect(body).toContain('until you re-enable it with fresh consent');
	});
});

describe('usage buy action', () => {
	test('an owner starts a Stripe Checkout for the bundle and redirects to it', async () => {
		await seedOrg();

		await expect(buy('credits_500')).rejects.toMatchObject({ status: 303, location: 'https://checkout.stripe.com/pay/test_123' });

		expect(mocks.customersCreate).toHaveBeenCalledWith(
			{ name: 'One', email: 'one@example.com', metadata: { org_id: 'org-1' } },
			{ idempotencyKey: 'customer:org-1' }
		);
		const [params] = mocks.sessionsCreate.mock.calls[0];
		expect(params).toMatchObject({
			mode: 'payment',
			line_items: [{ price: 'price_500', quantity: 1 }],
			customer: 'cus_new',
			client_reference_id: 'org-1',
			metadata: { org_id: 'org-1', bundle: 'credits_500', credits: '500' },
			payment_intent_data: { setup_future_usage: 'off_session' },
			success_url: 'http://localhost:5173/usage/success?session_id={CHECKOUT_SESSION_ID}'
		});
		// The org's Stripe customer id is persisted for reuse.
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeCustomerId).toBe('cus_new');
	});

	test('a second purchase reuses the saved customer', async () => {
		await seedOrg({ stripeCustomerId: 'cus_existing' });

		await expect(buy('credits_100')).rejects.toMatchObject({ status: 303 });

		expect(mocks.customersCreate).not.toHaveBeenCalled();
		expect(mocks.sessionsCreate.mock.calls[0][0].customer).toBe('cus_existing');
	});

	test('a checkout failure returns a generic message, never the raw Stripe error', async () => {
		// Raw third-party error text must never reach the client (it can leak
		// card/bank details) — full details go to the server log only.
		await seedOrg();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.sessionsCreate.mockRejectedValue(Object.assign(new Error('Your card number is incomplete. (card_error)'), { type: 'card_error' }));

		const result = await buy('credits_500');

		expect(result).toMatchObject({ status: 400 });
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('Your card number is incomplete');
		expect(serialized).toContain('try again');
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Your card number is incomplete'));
		errorSpy.mockRestore();
	});

	test('non-owners cannot buy (403)', async () => {
		await seedOrg();
		const member = { ...OWNER, orgRole: 'member' as const };

		await expect(buy('credits_100', member)).rejects.toMatchObject({ status: 403 });
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
	});

	test('a bundle Price whose amount contradicts the advertised discount answers 400 — never "try again"', async () => {
		// validateBundlePrice rejects the misconfigured catalog entry before
		// any durable state; the action must surface the sanitized
		// non-retryable verdict instead of a generic retry prompt (codex).
		await seedOrg();
		mocks.pricesRetrieve.mockResolvedValue({ id: 'price_500', active: true, currency: 'usd', type: 'one_time', unit_amount: 4900 });
		const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
		try {
			const result = await buy('credits_500');
			expect(result).toMatchObject({ status: 400 });
			const serialized = JSON.stringify(result);
			expect(serialized).toContain('misconfigured');
			expect(serialized).not.toContain('STRIPE_PRICE_CREDITS_500');
			expect(serialized).not.toContain('try again');
			expect(mocks.sessionsCreate).not.toHaveBeenCalled();
			expect(await testDb().db.select().from(stripeCheckoutAttempts)).toHaveLength(0);
		} finally {
			infoSpy.mockRestore();
		}
	});

	test('an unknown bundle fails loudly without echoing the submitted id', async () => {
		// A tampered/stale bundle id is an internal validation failure — the
		// response stays generic (500), the detail lives in the server log only.
		await seedOrg();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await buy('credits_999999');
			expect(result).toMatchObject({ status: 500 });
			const serialized = JSON.stringify(result);
			expect(serialized).toContain('Could not start checkout');
			expect(serialized).not.toContain('credits_999999');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown credit bundle'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('an unconfigured bundle price fails loudly without leaking env internals', async () => {
		// A missing STRIPE_PRICE_* env var is a server defect (500) — the env
		// var name is internal configuration detail, never client copy.
		await seedOrg();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.sessionsCreate.mockRejectedValue(new Error('STRIPE_PRICE_CREDITS_500 is not configured'));
		try {
			const result = await buy('credits_500');
			expect(result).toMatchObject({ status: 500 });
			const serialized = JSON.stringify(result);
			expect(serialized).toContain('Could not start checkout');
			expect(serialized).not.toContain('STRIPE_PRICE_CREDITS_500');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('STRIPE_PRICE_CREDITS_500'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a lifetime org cannot open a Stripe credit checkout — unlimited plans never buy credits', async () => {
		// The lifetime plan's scoring is already unlimited: a crafted POST
		// (the button is hidden in the UI) must fail loudly BEFORE a Checkout
		// Session exists — never sell a balance the org can never need. This
		// is a KNOWN domain rejection, so the response carries the real reason
		// (400), not the generic defect message.
		await seedOrg({ plan: 'lifetime' });
		const result = await buy('credits_100');
		expect(result).toMatchObject({ status: 400 });
		expect(JSON.stringify(result)).toContain('unlimited moderated comments');
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
		expect(mocks.customersCreate).not.toHaveBeenCalled();
		expect(await testDb().db.select().from(stripeCheckoutAttempts)).toHaveLength(0);
	});

	test('a lifetime org cannot open a Mercado Pago credit checkout', async () => {
		// Same guard on the BRL path: the check must run before any provider
		// validation or attempt row, so no MP env config is needed here.
		await seedOrg({ plan: 'lifetime' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = (await actions.buyMercadoPago({ request: postForm({ bundle: 'credits_100' }), locals: { user: OWNER } } as never)) as { status: number };
			expect(result.status).toBeGreaterThanOrEqual(400);
			expect(errorSpy.mock.calls.flat().some((arg) => arg instanceof Error && arg.message.includes('lifetime'))).toBe(true);
			expect(await testDb().db.select().from(mercadoPagoCheckoutAttempts)).toHaveLength(0);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe('usage buyTest action', () => {
	test('an owner starts a test Checkout tagged product=test and redirects to it', async () => {
		await seedOrg();

		await expect(buyTest()).rejects.toMatchObject({ status: 303, location: 'https://checkout.stripe.com/pay/test_123' });

		expect(mocks.sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
			mode: 'payment',
			line_items: [{ price: 'price_test', quantity: 1 }],
			metadata: { org_id: 'org-1', product: 'test' }
		}), expect.anything());
	});

	test('a crafted POST with STRIPE_TEST_PRODUCT unset fails loudly without leaking the env name', async () => {
		// The button is hidden without the env var, but the action re-validates:
		// a missing var is a server defect (500), generic to the client, loud in
		// the log — and it must not plant a checkout attempt row.
		await seedOrg();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		(env as Record<string, string | undefined>).STRIPE_TEST_PRODUCT = undefined;
		try {
			const result = await buyTest();
			expect(result).toMatchObject({ status: 500 });
			const serialized = JSON.stringify(result);
			expect(serialized).toContain('Could not start checkout');
			expect(serialized).not.toContain('STRIPE_TEST_PRODUCT');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('STRIPE_TEST_PRODUCT'));
			expect(await testDb().db.select().from(stripeCheckoutAttempts)).toHaveLength(0);
		} finally {
			env.STRIPE_TEST_PRODUCT = 'price_test';
			errorSpy.mockRestore();
		}
	});

	test('a misconfigured STRIPE_TEST_PRODUCT answers 400 with a sanitized reason — never "try again"', async () => {
		// The advertised button would otherwise fail forever behind a generic
		// retry message (codeant): a bad test-product config is a non-retryable
		// operator rejection — specific about WHAT without leaking env names or
		// Stripe internals, loud in the server log.
		await seedOrg();
		env.STRIPE_TEST_PRODUCT = 'price_inactive';
		mocks.pricesRetrieve.mockResolvedValueOnce({ id: 'price_inactive', active: false, currency: 'usd', type: 'one_time', unit_amount: 100 });
		const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
		try {
			const result = await buyTest();
			expect(result).toMatchObject({ status: 400 });
			const serialized = JSON.stringify(result);
			expect(serialized).toContain('misconfigured');
			expect(serialized).not.toContain('STRIPE_TEST_PRODUCT');
			expect(serialized).not.toContain('try again');
			expect(await testDb().db.select().from(stripeCheckoutAttempts)).toHaveLength(0);
		} finally {
			infoSpy.mockRestore();
		}
	});

	test('non-owners cannot open the test checkout (403)', async () => {
		await seedOrg();
		const member = { ...OPERATOR, orgRole: 'member' as const };

		await expect(buyTest(member)).rejects.toMatchObject({ status: 403 });
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
	});

	test('a crafted POST from an owner who is not the operator gets 403 — hiding the card is not the enforcement', async () => {
		await seedOrg();

		await expect(buyTest(OWNER)).rejects.toMatchObject({ status: 403 });
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
		expect(await testDb().db.select().from(stripeCheckoutAttempts)).toHaveLength(0);
	});
});

describe('usage setAutoTopup action', () => {
	test('enabling requires the consent checkbox and saves threshold + state', async () => {
		await seedOrg();

		const result = await setAutoTopup({ enabled: 'on', threshold: '250', consent: 'on' });

		expect(result).toMatchObject({ ok: true });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupEnabled).toBe(1);
		expect(org?.autoTopupThreshold).toBe(250);
		expect(org?.autoTopupState).toBe('idle');
		expect(org?.autoTopupFailures).toBe(0);
	});

	test('enabling persists the consent evidence (exact checkbox text, version, user, timestamp)', async () => {
		// Stripe's save-and-reuse compliance requires a record of the written
		// agreement — who ticked which sentence under which legal version, when.
		await seedOrg();

		const result = await setAutoTopup({ enabled: 'on', threshold: '250', consent: 'on' });

		expect(result).toMatchObject({ ok: true });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupConsentText).toBe(AUTO_TOPUP_CONSENT_TEXT);
		expect(org?.autoTopupConsentVersion).toBe(LEGAL_VERSION);
		expect(org?.autoTopupConsentedBy).toBe(OWNER.id);
		expect(org?.autoTopupConsentedAt).toBeTruthy();
	});

	test('disabling keeps the consent evidence on record', async () => {
		// The authorization record survives re-enabling cycles — it documents
		// that consent WAS given, and must never be wiped by turning the
		// automation off.
		await seedOrg({
			autoTopupEnabled: 1,
			autoTopupState: 'idle',
			autoTopupConsentText: AUTO_TOPUP_CONSENT_TEXT,
			autoTopupConsentVersion: LEGAL_VERSION,
			autoTopupConsentedBy: OWNER.id,
			autoTopupConsentedAt: '2026-08-17T00:00:00.000Z'
		});

		const result = await setAutoTopup({ threshold: '250' });

		expect(result).toMatchObject({ ok: true });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupConsentText).toBe(AUTO_TOPUP_CONSENT_TEXT);
		expect(org?.autoTopupConsentVersion).toBe(LEGAL_VERSION);
	});

	test('updating the threshold while ALREADY enabled needs no consent checkbox (it is hidden)', async () => {
		// The page only renders the consent checkbox when auto top-up is
		// disabled — an already-enabled org updating its threshold submits
		// enabled=on without consent, and must not 400 on every save.
		await seedOrg({ autoTopupEnabled: 1, autoTopupState: 'idle', autoTopupThreshold: 250 });

		const result = await setAutoTopup({ enabled: 'on', threshold: '500' });

		expect(result).toMatchObject({ ok: true });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupEnabled).toBe(1);
		expect(org?.autoTopupThreshold).toBe(500);
	});

	test('enabling without consent fails loudly', async () => {
		await seedOrg();

		const result = await setAutoTopup({ enabled: 'on', threshold: '250' });

		expect(result).toMatchObject({ status: 400 });
		expect(JSON.stringify(result)).toContain('consent');
	});

	test('a non-integer threshold fails loudly', async () => {
		await seedOrg();

		expect(await setAutoTopup({ enabled: 'on', threshold: 'abc', consent: 'on' })).toMatchObject({ status: 400 });
		expect(await setAutoTopup({ enabled: 'on', threshold: '-5', consent: 'on' })).toMatchObject({ status: 400 });
	});

	test('disabling clears the automation but keeps the threshold', async () => {
		await seedOrg({ autoTopupEnabled: 1, autoTopupThreshold: 250, autoTopupState: 'disabled' });

		const result = await setAutoTopup({ threshold: '250' });

		expect(result).toMatchObject({ ok: true });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupEnabled).toBe(0);
		expect(org?.autoTopupThreshold).toBe(250);
	});

	test('a MISSING threshold is rejected — Number("") must not silently become 0', async () => {
		// A malformed/stale submission without the threshold field converts to
		// '' → Number('') === 0, which would pass validation and set "top up
		// below zero" — silently stopping replenishment (codex 6161).
		await seedOrg({ autoTopupEnabled: 1, autoTopupThreshold: 100, autoTopupState: 'idle' });

		const result = await setAutoTopup({ enabled: 'on' });

		expect(result).toMatchObject({ status: 400 });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupThreshold).toBe(100);
	});

	test('a threshold-only update preserves an in-flight top-up claim', async () => {
		// The sweep may hold an in_flight claim (an off-session charge is
		// pending) while the owner tweaks the threshold — resetting the claim
		// here would let a later sweep create a SECOND PaymentIntent
		// (coderabbit).
		await seedOrg({ autoTopupEnabled: 1, autoTopupThreshold: 100, autoTopupState: 'in_flight', autoTopupFailures: 2 });

		const result = await setAutoTopup({ enabled: 'on', threshold: '150' });

		expect(result).toMatchObject({ ok: true });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupThreshold).toBe(150);
		expect(org?.autoTopupState).toBe('in_flight');
		expect(org?.autoTopupFailures).toBe(2);
	});

	test('an update while disabled recovers the claim (clean slate)', async () => {
		// SCA/decline failures leave the org enabled but 'disabled' — the
		// owner's update is the recovery action and must reset the state.
		await seedOrg({ autoTopupEnabled: 1, autoTopupThreshold: 100, autoTopupState: 'disabled', autoTopupFailures: 2 });

		const result = await setAutoTopup({ enabled: 'on', threshold: '150' });

		expect(result).toMatchObject({ ok: true });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupState).toBe('idle');
		expect(org?.autoTopupFailures).toBe(0);
	});

	test('non-owners cannot change auto top-up (403)', async () => {
		await seedOrg();
		const member = { ...OWNER, orgRole: 'member' as const };
		await expect(setAutoTopup({ enabled: 'on', threshold: '250', consent: 'on' }, member)).rejects.toMatchObject({ status: 403 });
	});

	test('a lifetime org cannot enable or update auto top-up; disabling stays allowed', async () => {
		// Unlimited scoring makes a top-up charge pure waste — enabling (or a
		// threshold update while a stale flag survives) is a loud 400. Turning
		// the flag OFF must still work so a stale flag can be cleared.
		await seedOrg({ plan: 'lifetime', autoTopupEnabled: 1, autoTopupThreshold: 100, autoTopupState: 'idle' });

		const enable = await setAutoTopup({ enabled: 'on', threshold: '150' });
		expect(enable).toMatchObject({ status: 400 });
		expect(JSON.stringify(enable)).toContain('lifetime');
		expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.autoTopupThreshold).toBe(100);

		const off = await setAutoTopup({ threshold: '150' });
		expect(off).toMatchObject({ ok: true });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupEnabled).toBe(0);
		expect(org?.autoTopupThreshold).toBe(100); // disabling keeps the stored threshold
	});

	test('disabling needs no threshold — the lifetime disable-only control submits no fields', async () => {
		// The lifetime card renders a bare disable button: no threshold field
		// exists on it, so the missing-threshold guard must not fire for a
		// DISABLE submit — the flag the control exists to clear would be
		// unreachable otherwise (codex, round 3).
		await seedOrg({ plan: 'lifetime', autoTopupEnabled: 1, autoTopupThreshold: 100, autoTopupState: 'idle' });

		const result = await setAutoTopup({});

		expect(result).toMatchObject({ ok: true });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupEnabled).toBe(0);
		expect(org?.autoTopupThreshold).toBe(100);
	});

	test('an enable that loses the plan race fails loudly instead of leaving a stale flag', async () => {
		// The read-time plan check happens BEFORE the write: a lifetime
		// webhook landing in between must not let the UPDATE plant enabled=1
		// on an unmetered org — the write itself re-checks the plan (review).
		await seedOrg();
		const client = testDb().client;
		const originalExecute = client.execute.bind(client);
		client.execute = (async (stmt: unknown) => {
			const sqlText = String((stmt as { sql?: string }).sql ?? stmt);
			if (/update "organizations" set/i.test(sqlText) && sqlText.includes('auto_topup_enabled')) {
				await originalExecute("update organizations set plan = 'lifetime' where id = 'org-1'");
			}
			return originalExecute(stmt as never);
		}) as never;
		try {
			const result = await setAutoTopup({ enabled: 'on', threshold: '250', consent: 'on' });
			expect(result).toMatchObject({ status: 400 });
		} finally {
			client.execute = originalExecute;
		}
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.autoTopupEnabled).toBeFalsy(); // never armed — the flag stays unset
	});
});


describe('usage plan checkout action', () => {
	test('owner can start hosted checkout', async () => {
		await seedOrg();
		await expect(buyPlan('hosted')).rejects.toMatchObject({ status: 303, location: 'https://checkout.stripe.com/pay/test_123' });
		expect(mocks.pricesRetrieve).toHaveBeenCalledWith('price_hosted');
		expect(mocks.sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
			mode: 'subscription',
			line_items: [{ price: 'price_hosted', quantity: 1 }],
			metadata: { org_id: 'org-1', product: 'hosted' },
			subscription_data: { metadata: { org_id: 'org-1', product: 'hosted' } }
		}), expect.objectContaining({ idempotencyKey: expect.stringMatching(/^checkout:/) }));
	});

	test('non-owners cannot start a hosted checkout', async () => {
		await seedOrg();
		const member = { ...OWNER, orgRole: 'member' as const };
		await expect(buyPlan('hosted', member)).rejects.toMatchObject({ status: 403 });
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
	});

	test('unknown plan is rejected before Stripe', async () => {
		await seedOrg();
		const result = await buyPlan('not-a-plan');
		expect(result).toMatchObject({ status: 400, data: { error: 'Unknown billing plan.' } });
		expect(mocks.pricesRetrieve).not.toHaveBeenCalled();
	});

	test('a hosted org re-buying hosted gets a specific 400, never a generic 500', async () => {
		// The button is hidden in the UI, but a crafted/stale POST must answer
		// with the REAL reason — a generic "try again" implies retrying would
		// help when the purchase can never succeed (MOD buttons investigation).
		await seedOrg({ plan: 'hosted', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		const result = await buyPlan('hosted');
		expect(result).toMatchObject({ status: 400 });
		expect(JSON.stringify(result)).toContain('already');
		expect(JSON.stringify(result)).toContain('subscription');
		expect(JSON.stringify(result)).not.toContain('sub_1');
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
	});

	test('a hosted org buying lifetime is told to cancel first — specific 400, not a defect page', async () => {
		await seedOrg({ plan: 'hosted', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		const result = await buyPlan('lifetime');
		expect(result).toMatchObject({ status: 400 });
		expect(JSON.stringify(result).toLowerCase()).toContain('cancel');
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
	});

	test('a lifetime org buying any plan hears that it already owns it', async () => {
		await seedOrg({ plan: 'lifetime' });
		for (const plan of ['hosted', 'lifetime']) {
			const result = await buyPlan(plan);
			expect(result).toMatchObject({ status: 400 });
			expect(JSON.stringify(result)).toContain('lifetime plan');
		}
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
	});

	test('a sold-out lifetime plan says so to the buyer', async () => {
		// Exhaust the slot pool first so the domain rejection fires.
		await seedOrg();
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1' });
		const result = await buyPlan('lifetime');
		expect(result).toMatchObject({ status: 400 });
		expect(JSON.stringify(result)).toContain('sold out');
	});
});

describe('usage manageCards action (Stripe customer portal)', () => {
	/** Swaps APP_URL for the body and always restores it — even on failure. */
	async function withAppUrl(value: string | undefined, body: () => Promise<void>) {
		const { env } = await import('$env/dynamic/private');
		const original = env.APP_URL as string | undefined;
		if (value === undefined) delete (env as Record<string, unknown>).APP_URL;
		else (env as Record<string, unknown>).APP_URL = value;
		try {
			await body();
		} finally {
			if (original === undefined) delete (env as Record<string, unknown>).APP_URL;
			else (env as Record<string, unknown>).APP_URL = original;
		}
	}

	/**
	 * A manageCards failure contract: generic 500, the configured message, none
	 * of the internal details in the response, and the raw detail logged
	 * server-side. console.error stays silenced for the duration.
	 */
	async function expectPortalFailure(opts: { notContaining: string[]; logged: string }) {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await manageCards();
			expect(result).toMatchObject({ status: 500 });
			const serialized = JSON.stringify(result);
			expect(serialized).toContain('Could not open the card manager');
			for (const leak of opts.notContaining) expect(serialized).not.toContain(leak);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(opts.logged));
		} finally {
			errorSpy.mockRestore();
		}
	}

	test('rejects a signed-out request with 401', async () => {
		await expect(manageCards(null)).rejects.toMatchObject({ status: 401 });
		expect(mocks.billingPortalSessionsCreate).not.toHaveBeenCalled();
	});

	test('rejects a non-owner with 403', async () => {
		await seedOrg({ stripeCustomerId: 'cus_1' });
		await expect(manageCards({ ...OWNER, orgRole: 'member' as const })).rejects.toMatchObject({ status: 403 });
		expect(mocks.billingPortalSessionsCreate).not.toHaveBeenCalled();
	});

	test('redirects the owner to a portal session for the org customer with a /usage return', async () => {
		await seedOrg({ stripeCustomerId: 'cus_1' });
		mocks.billingPortalSessionsCreate.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/test_123' });

		await expect(manageCards()).rejects.toMatchObject({ status: 303, location: 'https://billing.stripe.com/p/session/test_123' });

		expect(mocks.billingPortalSessionsCreate).toHaveBeenCalledWith({ customer: 'cus_1', return_url: 'http://localhost:5173/usage' });
	});

	test('creates the Stripe customer first when the org has none', async () => {
		await seedOrg();
		mocks.billingPortalSessionsCreate.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/test_123' });

		await expect(manageCards()).rejects.toMatchObject({ status: 303 });

		expect(mocks.customersCreate).toHaveBeenCalledWith({ name: 'One', email: 'one@example.com', metadata: { org_id: 'org-1' } }, { idempotencyKey: 'customer:org-1' });
		expect(mocks.billingPortalSessionsCreate).toHaveBeenCalledWith({ customer: 'cus_new', return_url: 'http://localhost:5173/usage' });
	});

	test('a Stripe failure returns a generic message and logs the raw error server-side only', async () => {
		// Raw third-party error text must never reach the client — same rule as
		// checkout (it can leak card/bank details).
		await seedOrg({ stripeCustomerId: 'cus_1' });
		mocks.billingPortalSessionsCreate.mockRejectedValue(Object.assign(new Error('no configuration with payment method update, card brand visa'), { type: 'StripeInvalidRequestError' }));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await manageCards();

		expect(result).toMatchObject({ status: 400 });
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('card brand visa');
		expect(serialized).toContain('Could not open the card manager');
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no configuration with payment method update'));
		errorSpy.mockRestore();
	});

	test('a missing APP_URL fails 500 BEFORE any Stripe customer is created', async () => {
		// Env validation belongs at handler start (AGENTS.md): creating the
		// remote customer first would leave an external side effect from a
		// request that could never open the portal (codex P1).
		await seedOrg(); // no stripeCustomerId — the create path is the trap
		await withAppUrl(undefined, async () => {
			await expect(manageCards()).rejects.toMatchObject({ status: 500 });
			expect(mocks.customersCreate).not.toHaveBeenCalled();
			expect(mocks.billingPortalSessionsCreate).not.toHaveBeenCalled();
		});
	});

	test('a malformed APP_URL fails 500 BEFORE any Stripe customer is created', async () => {
		// A non-empty but unparseable APP_URL passes a presence-only check and
		// would create the customer before new URL() throws (cubic/codex P2).
		await seedOrg(); // no stripeCustomerId — the create path is the trap
		await withAppUrl('moderaty.example', async () => {
			await expect(manageCards()).rejects.toMatchObject({ status: 500 });
			expect(mocks.customersCreate).not.toHaveBeenCalled();
			expect(mocks.billingPortalSessionsCreate).not.toHaveBeenCalled();
		});
	});

	test('a portal session without a URL is a loud 500, never a broken redirect', async () => {
		// I1: every field of a Stripe response is nullable — an unvalidated
		// session.url would emit a broken Location header (codex P1). The thrown
		// message embeds the Stripe customer id — internal detail that must stay
		// in the server log, never reach the client (codex P1).
		await seedOrg({ stripeCustomerId: 'cus_1' });
		mocks.billingPortalSessionsCreate.mockResolvedValue({});
		await expectPortalFailure({ notContaining: ['cus_1'], logged: 'portal' });
	});

	test('a non-https portal URL is a loud 500, never an off-scheme redirect', async () => {
		// Portal URLs are always https://billing.stripe.com/... — anything else
		// from the API response is malformed and must not become a Location
		// header (cubic P2). Same no-leak rule on the customer id.
		await seedOrg({ stripeCustomerId: 'cus_1' });
		mocks.billingPortalSessionsCreate.mockResolvedValue({ url: 'http://phishing.example/portal' });
		await expectPortalFailure({ notContaining: ['cus_1'], logged: 'portal' });
	});

	test('a customer-creation failure is a generic 500 — DB internals stay in the server log', async () => {
		// getOrCreateStripeCustomer can fail with raw libsql/driver errors whose
		// messages carry internal detail; the client gets a generic 500 (codex).
		await seedOrg(); // no stripeCustomerId — the create path runs
		mocks.customersCreate.mockRejectedValue(new Error('libsql: SECRET connection detail'));
		await expectPortalFailure({ notContaining: ['libsql', 'SECRET'], logged: 'libsql: SECRET connection detail' });
	});
});

describe('usage cards section', () => {
	function renderUsage(overrides: Record<string, unknown> = {}) {
		return render(Page, {
			props: {
				data: {
					maintenance: false,
					user: OWNER,
					summary: { remaining: 10, usedThisMonth: 0, usedLifetime: 0 },
					metered: true,
					mercadoPagoBundles: [],
					history: [],
					bundles: [],
					autoTopup: { enabled: false, threshold: 100, state: 'idle', failures: 0, lastAttemptAt: null, hasCard: true },
					autoTopupConsentText: 'consent',
					stripeConfigured: true,
					plans: { hosted: false, lifetime: false },
					...overrides
				},
				form: null
			} as never
		}).body;
	}

	test('an owner sees the Cards section with the manage button', () => {
		const body = renderUsage();
		expect(body).toContain('action="?/manageCards"');
		expect(body).toContain('Manage cards');
		// The saved card backs automatic top-up only — Checkout saves it with
		// setup_future_usage: 'off_session' (allow_redisplay: limited), so it is
		// never prefilled in later Checkout sessions; promising "future
		// purchases" overclaims (cubic P2).
		expect(body).toContain('A card is saved for automatic top-up.');
		expect(body).not.toContain('future purchases');
	});

	test('the resolved card label renders instead of the generic sentence', () => {
		// The owner should SEE which card is on file — the portal's card list
		// and Moderaty's copy must agree.
		const body = renderUsage({
			autoTopup: { enabled: false, threshold: 100, state: 'idle', failures: 0, lastAttemptAt: null, hasCard: true, card: { label: 'Visa •••• 4242' } }
		});
		expect(body).toContain('Visa •••• 4242');
		expect(body).not.toContain('No card saved');
	});

	test('a malformed card payload resolves to unavailable — never rendered as a trusted label', async () => {
		// I2: Stripe's card fields are external data — a one-character last4 or
		// an empty brand must not render as if it were a real saved card
		// (codex P1). Malformed means logged + unavailable, not displayed.
		await seedOrg({ creditsRemaining: 5, autoTopupEnabled: 1, autoTopupThreshold: 100, autoTopupState: 'idle', stripeDefaultPmId: 'pm_1' });
		mocks.paymentMethodsRetrieve.mockResolvedValue({ id: 'pm_1', type: 'card', card: { brand: 'visa', last4: 'x' } });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const data = (await load({ locals: { user: OWNER } } as never)) as { autoTopup: { hasCard: boolean; card: unknown } };
			expect(data.autoTopup.hasCard).toBe(true);
			expect(data.autoTopup.card).toBeNull();
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('malformed'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a card pointer with unresolved details says so instead of implying which card', () => {
		const body = renderUsage({
			autoTopup: { enabled: false, threshold: 100, state: 'idle', failures: 0, lastAttemptAt: null, hasCard: true, card: null }
		});
		expect(body).toContain('A card is saved for automatic top-up.');
		expect(body).toContain('unavailable');
	});

	test('a member never sees the card manager', () => {
		const body = renderUsage({ user: { ...OWNER, orgRole: 'member' } });
		expect(body).not.toContain('manageCards');
	});

	test('a Stripe-less self-hosted instance gets an explicit unavailable state, never a broken form', () => {
		// Self-hosted/free deployments without STRIPE_SECRET_KEY can never open
		// the customer portal — rendering the control would be a permanently
		// failing button (codex P2, I12). The load passes a non-secret
		// availability flag; the section says why instead of breaking.
		const body = renderUsage({ stripeConfigured: false });
		expect(body).not.toContain('manageCards');
		expect(body).toContain('not configured');
	});

	test('the no-card state says so instead of implying one is saved', () => {
		const body = renderUsage({
			autoTopup: { enabled: false, threshold: 100, state: 'idle', failures: 0, lastAttemptAt: null, hasCard: false }
		});
		expect(body).toContain('No card saved yet');
		expect(body).not.toContain('A card is saved');
		// Only a STRIPE bundle saves a card — a Mercado Pago purchase saves no
		// Stripe payment method, so "buy any bundle" would mislead (cubic P2).
		expect(body).toContain('buy a Stripe bundle once');
		expect(body).not.toContain('buy any bundle');
	});
});
