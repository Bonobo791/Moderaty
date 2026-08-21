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

import { setupTestDb, testDb } from '$lib/server/testdb';
import { organizations, stripeLifetimeSlots } from '$lib/server/db/schema';
import { createCreditCheckout, createPlanCheckout, getOrCreateStripeCustomer } from './checkout';
import type { SessionUser } from '$lib/server/session';

const mocks = vi.hoisted(() => ({
	customersCreate: vi.fn(),
	sessionsCreate: vi.fn(),
	pricesRetrieve: vi.fn(),
	sessionsRetrieve: vi.fn()
}));

vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => ({
		customers: { create: mocks.customersCreate },
		checkout: { sessions: { create: mocks.sessionsCreate, retrieve: mocks.sessionsRetrieve } },
		prices: { retrieve: mocks.pricesRetrieve }
	})
}));
vi.mock('$env/dynamic/private', () => ({
	env: { APP_URL: 'https://app.example', STRIPE_PRICE_CREDITS_100: 'price_100', STRIPE_PRICE_CREDITS_500: 'price_500', STRIPE_PRICE_CREDITS_2000: 'price_2000', STRIPE_PRICE_HOSTED_MONTHLY: 'price_hosted', STRIPE_PRICE_LIFETIME: 'price_lifetime' }
}));

setupTestDb(['organizations', 'stripe_lifetime_slots', 'stripe_checkout_attempts']);

function owner(overrides: Partial<SessionUser> = {}): SessionUser {
	return {
		id: 'user-1',
		email: 'owner@example.com',
		displayName: 'Owner',
		plan: 'free',
		orgId: 'org-1',
		orgName: 'Org',
		orgRole: 'owner',
		...overrides
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.customersCreate.mockResolvedValue({ id: 'cus_1' });
	mocks.sessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
	mocks.pricesRetrieve.mockImplementation(async (id: string) => id === 'price_hosted' ? { id, active: true, currency: 'usd', type: 'recurring', unit_amount: 500, recurring: { interval: 'month', interval_count: 1 } } : { id, active: true, currency: 'usd', type: 'one_time', unit_amount: 4900 });
});

describe('getOrCreateStripeCustomer', () => {
	test('creates and stores the customer on first use', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });

		const customerId = await getOrCreateStripeCustomer('org-1', owner());

		expect(customerId).toBe('cus_1');
		expect(mocks.customersCreate).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Org', email: 'owner@example.com', metadata: { org_id: 'org-1' } }),
			expect.objectContaining({ idempotencyKey: 'customer:org-1' })
		);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeCustomerId).toBe('cus_1');
	});

	test('returns the stored customer without creating another', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeCustomerId: 'cus_existing' });

		const customerId = await getOrCreateStripeCustomer('org-1', owner());

		expect(customerId).toBe('cus_existing');
		expect(mocks.customersCreate).not.toHaveBeenCalled();
	});

	test('concurrent provisioning stores ONE customer and both callers get the stored id', async () => {
		// Two Checkout requests can race on a missing customer id. Each create
		// would mint a DIFFERENT customer; the losing claim must re-read the
		// stored id instead of returning its own orphan — or sessions and
		// saved payment methods attach to a customer the org does not own
		// (coderabbit).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		// Deferred per call, so BOTH requests reach customers.create (the race
		// window) before either result lands.
		const resolvers: ((value: unknown) => void)[] = [];
		mocks.customersCreate.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
		const first = getOrCreateStripeCustomer('org-1', owner());
		const second = getOrCreateStripeCustomer('org-1', owner());
		await vi.waitFor(() => expect(resolvers).toHaveLength(2));
		// What really happens without a shared idempotency key: two DISTINCT
		// customers minted concurrently.
		resolvers[0]({ id: 'cus_1' });
		resolvers[1]({ id: 'cus_2' });
		const [idA, idB] = await Promise.all([first, second]);

		// The invariant: every caller returns the ONE stored customer — a
		// losing claim must re-read the org row, never hand out its orphan
		// (or sessions and saved payment methods attach to a customer the org
		// does not own).
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(['cus_1', 'cus_2']).toContain(org?.stripeCustomerId);
		expect(idA).toBe(org?.stripeCustomerId);
		expect(idB).toBe(org?.stripeCustomerId);
		expect(mocks.customersCreate).toHaveBeenCalledTimes(2);
	});
});


describe('createPlanCheckout', () => {
	test('creates the hosted monthly subscription with a validated server catalog price', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		const url = await createPlanCheckout('org-1', owner(), 'hosted', 'attempt-hosted');
		expect(url).toBe('https://checkout.stripe.com/c/pay/cs_1');
		expect(mocks.pricesRetrieve).toHaveBeenCalledWith('price_hosted');
		expect(mocks.sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
			mode: 'subscription',
			line_items: [{ price: 'price_hosted', quantity: 1 }],
			metadata: { org_id: 'org-1', product: 'hosted' },
			subscription_data: { metadata: { org_id: 'org-1', product: 'hosted' } }
		}), { idempotencyKey: expect.stringMatching(/^checkout:attempt-hosted:/) });
	});

	test('reuses an open attempt instead of creating a second Checkout Session', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		const first = await createPlanCheckout('org-1', owner(), 'hosted', 'attempt-retry');
		mocks.sessionsRetrieve.mockResolvedValue({ id: 'cs_1', status: 'open', url: first });
		const second = await createPlanCheckout('org-1', owner(), 'hosted', 'attempt-retry');
		expect(second).toBe(first);
		expect(mocks.sessionsCreate).toHaveBeenCalledTimes(1);
		expect(mocks.sessionsRetrieve).toHaveBeenCalledWith('cs_1');
	});

	test('uses a fresh Stripe idempotency key after an expired attempt', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await createPlanCheckout('org-1', owner(), 'hosted', 'attempt-expired');
		const firstKey = mocks.sessionsCreate.mock.calls[0][1].idempotencyKey as string;
		mocks.sessionsRetrieve.mockResolvedValue({ id: 'cs_1', status: 'expired', url: null });
		mocks.sessionsCreate.mockResolvedValueOnce({ id: 'cs_2', url: 'https://checkout.stripe.com/c/pay/cs_2' });
		await createPlanCheckout('org-1', owner(), 'hosted', 'attempt-expired');
		const secondKey = mocks.sessionsCreate.mock.calls[1][1].idempotencyKey as string;
		expect(secondKey).not.toBe(firstKey);
		expect(mocks.sessionsCreate).toHaveBeenCalledTimes(2);
	});

	test('rejects a lifetime checkout while a hosted subscription is active', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'active' });
		await expect(createPlanCheckout('org-1', owner(), 'lifetime')).rejects.toThrow('already has an active hosted subscription');
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
	});
	test('rejects a hosted checkout while the organization has lifetime access', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', plan: 'lifetime' });
		await expect(createPlanCheckout('org-1', owner(), 'hosted')).rejects.toThrow('already has the lifetime plan');
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
	});


	test('rejects a hosted checkout when the catalog price is not the configured amount', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		mocks.pricesRetrieve.mockResolvedValueOnce({ id: 'price_hosted', active: true, currency: 'usd', type: 'recurring', unit_amount: 900, recurring: { interval: 'month', interval_count: 1 } });
		await expect(createPlanCheckout('org-1', owner(), 'hosted')).rejects.toThrow('must be 500 cents');
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
	});

	test('rejects lifetime checkout when every lifetime slot is occupied', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await testDb().db.update(stripeLifetimeSlots).set({ activeOrgId: 'org-1' });
		await expect(createPlanCheckout('org-1', owner(), 'lifetime')).rejects.toThrow('lifetime plan is sold out');
		expect(mocks.pricesRetrieve).not.toHaveBeenCalled();
		expect(mocks.sessionsCreate).not.toHaveBeenCalled();
	});

	test('creates the lifetime payment with a validated one-time price', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		await createPlanCheckout('org-1', owner(), 'lifetime', 'attempt-lifetime');
		expect(mocks.pricesRetrieve).toHaveBeenCalledWith('price_lifetime');
		expect(mocks.sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
			mode: 'payment',
			line_items: [{ price: 'price_lifetime', quantity: 1 }],
			metadata: { org_id: 'org-1', product: 'lifetime' }
		}), { idempotencyKey: expect.stringMatching(/^checkout:attempt-lifetime:/) });
		expect(mocks.sessionsCreate.mock.calls[0][0].payment_intent_data).toBeUndefined();
	});
});

describe('createCreditCheckout', () => {
	test('creates the session for the org with bundle metadata and new-URL-built redirects', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });

		const url = await createCreditCheckout('org-1', owner(), 'credits_500');

		expect(url).toBe('https://checkout.stripe.com/c/pay/cs_1');
		expect(mocks.sessionsCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: 'payment',
				customer: 'cus_1',
				metadata: { org_id: 'org-1', bundle: 'credits_500', credits: '500' },
				success_url: 'https://app.example/usage/success?session_id={CHECKOUT_SESSION_ID}',
				cancel_url: 'https://app.example/usage'
			}),
			expect.objectContaining({ idempotencyKey: expect.stringMatching(/^checkout:/) })
		);
	});

	test('builds the redirect URLs with new URL(path, APP_URL) — never string interpolation', async () => {
		// Coding guideline: src/**/*.ts builds URLs with new URL(path, base).
		// Spy on the URL constructor so the CONSTRUCTION METHOD is pinned, not
		// just the resulting value (coderabbit).
		await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org' });
		const OriginalUrl = URL;
		const constructed: [string, string | undefined][] = [];
		vi.stubGlobal('URL', class extends OriginalUrl {
			constructor(input: string, base?: string) {
				super(input, base);
				constructed.push([input, base]);
			}
		});
		try {
			await createCreditCheckout('org-1', owner(), 'credits_500');
		} finally {
			vi.unstubAllGlobals();
		}
		expect(constructed.some(([input, base]) => input === '/usage/success?session_id={CHECKOUT_SESSION_ID}' && base === 'https://app.example')).toBe(true);
		expect(constructed.some(([input, base]) => input === '/usage' && base === 'https://app.example')).toBe(true);
	});
});
