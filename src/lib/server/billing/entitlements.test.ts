import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';

import { setupTestDb, testDb } from '$lib/server/testdb';
import { organizations, stripeLifetimeEntitlements, stripeLifetimeSlots, stripeSubscriptionPeriods } from '$lib/server/db/schema';
import { claimLifetimeSlot, grantSubscriptionPeriod, releaseLifetimeForPayment, applySubscriptionSnapshot } from './entitlements';
import { consumeCredit, getCredits } from './ledger';

setupTestDb(['organizations', 'stripe_subscription_periods', 'stripe_lifetime_entitlements', 'stripe_lifetime_slots']);

async function seedOrg(id = 'org-1') {
	await testDb().db.insert(organizations).values({ id, name: id });
}

describe('subscription period entitlements', () => {
	beforeEach(async () => seedOrg());

	test('grants one idempotent 100-comment period and updates the organization cache', async () => {
		const first = await grantSubscriptionPeriod({
			orgId: 'org-1', subscriptionId: 'sub-1', invoiceId: 'in-1', paymentIntentId: 'pi-1', chargeId: 'ch-1',
			periodKey: '2026-09-01', periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', eventCreated: 100, eventId: 'evt-1'
		});
		const second = await grantSubscriptionPeriod({
			orgId: 'org-1', subscriptionId: 'sub-1', invoiceId: 'in-1', paymentIntentId: 'pi-1', chargeId: 'ch-1',
			periodKey: '2026-09-01', periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', eventCreated: 100, eventId: 'evt-1'
		});
		expect(first).toBe(true);
		expect(second).toBe(false);
		expect(await testDb().db.select().from(stripeSubscriptionPeriods)).toHaveLength(1);
	});

	test('ignores an older subscription snapshot after a newer event', async () => {
		expect(await applySubscriptionSnapshot({ orgId: 'org-1', subscriptionId: 'sub-1', status: 'active', periodStart: '2026-09-01', periodEnd: '2026-10-01', cancelAtPeriodEnd: false, eventCreated: 200, eventId: 'evt-new' })).toBe(true);
		expect(await applySubscriptionSnapshot({ orgId: 'org-1', subscriptionId: 'sub-1', status: 'canceled', periodStart: '2026-09-01', periodEnd: '2026-10-01', cancelAtPeriodEnd: false, eventCreated: 100, eventId: 'evt-old' })).toBe(false);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.stripeSubscriptionStatus).toBe('active');
		expect(org?.stripeSubscriptionLastEventId).toBe('evt-new');
	});

	test('counts and consumes the current period before purchased overage', async () => {
		const now = Date.now();
		const periodStart = new Date(now - 86_400_000).toISOString();
		const periodEnd = new Date(now + 86_400_000).toISOString();
		await testDb().db.update(organizations).set({ plan: 'hosted', creditsRemaining: 2, stripeSubscriptionId: 'sub-1', stripeSubscriptionStatus: 'active', stripeSubscriptionPeriodEnd: periodEnd }).where(eq(organizations.id, 'org-1'));
		await testDb().db.insert(stripeSubscriptionPeriods).values({ orgId: 'org-1', subscriptionId: 'sub-1', invoiceId: 'in-1', periodKey: periodStart.slice(0, 7), periodStart, periodEnd, includedCredits: 2, consumedCredits: 0, status: 'paid' });
		expect(await getCredits('org-1')).toBe(4);
		expect(await consumeCredit(testDb().db, 'org-1', 'comment-1')).toBe(true);
		expect(await consumeCredit(testDb().db, 'org-1', 'comment-2')).toBe(true);
		expect(await consumeCredit(testDb().db, 'org-1', 'comment-3')).toBe(true);
		expect(await consumeCredit(testDb().db, 'org-1', 'comment-4')).toBe(true);
		expect(await getCredits('org-1')).toBe(0);
		const period = await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in-1')).get();
		expect(period?.consumedCredits).toBe(2);
	});
});

describe('lifetime entitlements', () => {
	beforeEach(async () => seedOrg());

	test('claims the first slot idempotently and marks the organization lifetime', async () => {
		const first = await claimLifetimeSlot({ orgId: 'org-1', checkoutSessionId: 'cs-1', paymentIntentId: 'pi-1', chargeId: 'ch-1' });
		const second = await claimLifetimeSlot({ orgId: 'org-1', checkoutSessionId: 'cs-1', paymentIntentId: 'pi-1', chargeId: 'ch-1' });
		expect(first).toMatchObject({ slot: 1, status: 'active' });
		expect(second).toEqual(first);
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		expect(org?.plan).toBe('lifetime');
	});

	test('releases a full-refunded lifetime payment and reuses its slot', async () => {
		await claimLifetimeSlot({ orgId: 'org-1', checkoutSessionId: 'cs-1', paymentIntentId: 'pi-1', chargeId: 'ch-1' });
		expect(await releaseLifetimeForPayment({ paymentIntentId: 'pi-1', chargeId: 'ch-1' })).toBe(true);
		const slot = await testDb().db.select().from(stripeLifetimeSlots).where(eq(stripeLifetimeSlots.slot, 1)).get();
		expect(slot?.activeOrgId).toBeNull();
		const entitlement = await testDb().db.select().from(stripeLifetimeEntitlements).where(eq(stripeLifetimeEntitlements.checkoutSessionId, 'cs-1')).get();
		expect(entitlement?.status).toBe('released');
		expect(await claimLifetimeSlot({ orgId: 'org-1', checkoutSessionId: 'cs-2', paymentIntentId: 'pi-2', chargeId: 'ch-2' })).toMatchObject({ slot: 1 });
	});
});
