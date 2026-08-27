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
import { organizations } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/session';
import { applyLedgerDelta, consumeCredit } from '$lib/server/billing/ledger';
import { AUTO_TOPUP_CONSENT_TEXT, LEGAL_VERSION } from '$lib/server/legal';

const mocks = vi.hoisted(() => ({
	sessionsCreate: vi.fn(),
	customersCreate: vi.fn(), pricesRetrieve: vi.fn(), billingPortalSessionsCreate: vi.fn()
}));

vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => ({
		checkout: { sessions: { create: mocks.sessionsCreate } },
		prices: { retrieve: mocks.pricesRetrieve },
		customers: { create: mocks.customersCreate },
		billingPortal: { sessions: { create: mocks.billingPortalSessionsCreate } }
	})
}));
vi.mock('$env/dynamic/private', () => ({
	env: {
		APP_URL: 'http://localhost:5173',
		STRIPE_PRICE_CREDITS_100: 'price_100',
		STRIPE_PRICE_CREDITS_500: 'price_500',
		STRIPE_PRICE_CREDITS_2000: 'price_2000',
		STRIPE_PRICE_HOSTED_MONTHLY: 'price_hosted',
		STRIPE_PRICE_LIFETIME: 'price_lifetime'
	}
}));

import { render } from 'svelte/server';

import Page from './+page.svelte';
import { actions, load } from './+page.server';

setupTestDb(['organizations', 'credit_transactions', 'stripe_events', 'stripe_checkout_attempts']);

const OWNER = TEST_OWNER;

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
	mocks.pricesRetrieve.mockImplementation(async (id: string) => id === 'price_hosted' ? { id, active: true, currency: 'usd', type: 'recurring', unit_amount: 500, recurring: { interval: 'month', interval_count: 1 } } : { id, active: true, currency: 'usd', type: 'one_time', unit_amount: 4900 });
});

describe('usage load', () => {
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
});

describe('usage manageCards action (Stripe customer portal)', () => {
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
		const { env } = await import('$env/dynamic/private');
		const original = env.APP_URL;
		delete (env as Record<string, unknown>).APP_URL;
		try {
			await expect(manageCards()).rejects.toMatchObject({ status: 500 });
			expect(mocks.customersCreate).not.toHaveBeenCalled();
			expect(mocks.billingPortalSessionsCreate).not.toHaveBeenCalled();
		} finally {
			(env as Record<string, unknown>).APP_URL = original;
		}
	});

	test('a malformed APP_URL fails 500 BEFORE any Stripe customer is created', async () => {
		// A non-empty but unparseable APP_URL passes a presence-only check and
		// would create the customer before new URL() throws (cubic/codex P2).
		await seedOrg(); // no stripeCustomerId — the create path is the trap
		const { env } = await import('$env/dynamic/private');
		const original = env.APP_URL;
		(env as Record<string, unknown>).APP_URL = 'moderaty.example';
		try {
			await expect(manageCards()).rejects.toMatchObject({ status: 500 });
			expect(mocks.customersCreate).not.toHaveBeenCalled();
			expect(mocks.billingPortalSessionsCreate).not.toHaveBeenCalled();
		} finally {
			(env as Record<string, unknown>).APP_URL = original;
		}
	});

	test('a portal session without a URL is a loud 500, never a broken redirect', async () => {
		// I1: every field of a Stripe response is nullable — an unvalidated
		// session.url would emit a broken Location header (codex P1). The thrown
		// message embeds the Stripe customer id — internal detail that must stay
		// in the server log, never reach the client (codex P1).
		await seedOrg({ stripeCustomerId: 'cus_1' });
		mocks.billingPortalSessionsCreate.mockResolvedValue({});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await manageCards();
			expect(result).toMatchObject({ status: 500 });
			const serialized = JSON.stringify(result);
			expect(serialized).toContain('Could not open the card manager');
			expect(serialized).not.toContain('cus_1');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('portal'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a non-https portal URL is a loud 500, never an off-scheme redirect', async () => {
		// Portal URLs are always https://billing.stripe.com/... — anything else
		// from the API response is malformed and must not become a Location
		// header (cubic P2). Same no-leak rule on the customer id.
		await seedOrg({ stripeCustomerId: 'cus_1' });
		mocks.billingPortalSessionsCreate.mockResolvedValue({ url: 'http://phishing.example/portal' });
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await manageCards();
			expect(result).toMatchObject({ status: 500 });
			const serialized = JSON.stringify(result);
			expect(serialized).toContain('Could not open the card manager');
			expect(serialized).not.toContain('cus_1');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('portal'));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test('a customer-creation failure is a generic 500 — DB internals stay in the server log', async () => {
		// getOrCreateStripeCustomer can fail with raw libsql/driver errors whose
		// messages carry internal detail; the client gets a generic 500 (codex).
		await seedOrg(); // no stripeCustomerId — the create path runs
		mocks.customersCreate.mockRejectedValue(new Error('libsql: SECRET connection detail'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await manageCards();
			expect(result).toMatchObject({ status: 500 });
			const serialized = JSON.stringify(result);
			expect(serialized).toContain('Could not open the card manager');
			expect(serialized).not.toContain('libsql');
			expect(serialized).not.toContain('SECRET');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('libsql: SECRET connection detail'));
		} finally {
			errorSpy.mockRestore();
		}
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

	test('a member never sees the card manager', () => {
		const body = renderUsage({ user: { ...OWNER, orgRole: 'member' } });
		expect(body).not.toContain('manageCards');
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
