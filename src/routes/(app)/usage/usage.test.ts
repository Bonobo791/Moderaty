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

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { TEST_OWNER, postForm, setupTestDb, testDb } from '$lib/server/testdb';
import { organizations } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/session';
import { applyLedgerDelta, consumeCredit } from '$lib/server/billing/ledger';
import { AUTO_TOPUP_CONSENT_TEXT, LEGAL_VERSION } from '$lib/server/legal';

const mocks = vi.hoisted(() => ({
	sessionsCreate: vi.fn(),
	customersCreate: vi.fn(), pricesRetrieve: vi.fn()
}));

vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => ({
		checkout: { sessions: { create: mocks.sessionsCreate } },
		prices: { retrieve: mocks.pricesRetrieve },
		customers: { create: mocks.customersCreate }
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

	test('an unknown bundle fails loudly with a 400', async () => {
		await seedOrg();
		const result = await buy('credits_999999');
		expect(result).toMatchObject({ status: 400 });
		expect(JSON.stringify(result)).toContain('unknown credit bundle');
	});

	test('an unconfigured bundle price fails loudly', async () => {
		await seedOrg();
		mocks.sessionsCreate.mockRejectedValue(new Error('STRIPE_PRICE_CREDITS_500 is not configured'));
		const result = await buy('credits_500');
		expect(result).toMatchObject({ status: 400 });
		expect(JSON.stringify(result)).toContain('Could not start checkout');
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
