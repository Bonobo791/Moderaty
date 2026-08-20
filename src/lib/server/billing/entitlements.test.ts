import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';

import { setupTestDb, testDb } from '$lib/server/testdb';
import { organizations, stripeLifetimeEntitlements, stripeLifetimeSlots, stripeSubscriptionPeriods, stripePendingReversals, stripeDisputeReversals } from '$lib/server/db/schema';
import { claimLifetimeSlot, grantSubscriptionPeriod, releaseLifetimeForPayment, applySubscriptionSnapshot, disputeSubscriptionPeriod, restoreDisputedSubscriptionPeriod, revokeLifetimeForDispute, restoreLifetimeForDispute } from './entitlements';
import { consumeCredit, getCredits } from './ledger';

setupTestDb(['organizations', 'stripe_subscription_periods', 'stripe_lifetime_entitlements', 'stripe_lifetime_slots', 'stripe_pending_reversals', 'stripe_dispute_reversals']);

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

	test('a refund queued before invoice fulfillment marks that period unusable', async () => {
		await testDb().db.insert(stripePendingReversals).values({ chargeId: 'ch-1', reason: 'refund' });
		await grantSubscriptionPeriod({
			orgId: 'org-1', subscriptionId: 'sub-1', invoiceId: 'in-1', paymentIntentId: 'pi-1', chargeId: 'ch-1',
			periodKey: 'period-1', periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', eventCreated: 100, eventId: 'evt-1'
		});
		const period = await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in-1')).get();
		expect(period?.status).toBe('refunded');
		expect(await testDb().db.select().from(stripePendingReversals)).toHaveLength(0);
	});

	test('a won dispute restores the subscription period allowance', async () => {
		await grantSubscriptionPeriod({ orgId: 'org-1', subscriptionId: 'sub-1', invoiceId: 'in-1', paymentIntentId: 'pi-1', chargeId: 'ch-1', periodKey: 'period-1', periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', eventCreated: 100, eventId: 'evt-1' });
		expect(await disputeSubscriptionPeriod({ paymentIntentId: 'pi-1', chargeId: 'ch-1' })).toBe(true);
		expect(await restoreDisputedSubscriptionPeriod({ paymentIntentId: 'pi-1', chargeId: 'ch-1' })).toBe(true);
		const period = await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in-1')).get();
		expect(period?.status).toBe('paid');
	});


	test('a won dispute recorded before invoice fulfillment keeps the period paid', async () => {
		await testDb().db.insert(stripePendingReversals).values({ chargeId: 'ch-1', reason: 'dispute', disputeId: 'disp-1' });
		await testDb().db.insert(stripeDisputeReversals).values({ disputeId: 'disp-1', chargeId: 'ch-1', paymentIntentId: 'pi-1', status: 'won', source: 'unknown' });
		await grantSubscriptionPeriod({ orgId: 'org-1', subscriptionId: 'sub-1', invoiceId: 'in-1', paymentIntentId: 'pi-1', chargeId: 'ch-1', periodKey: 'period-1', periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', eventCreated: 100, eventId: 'evt-1' });
		expect((await testDb().db.select().from(stripeSubscriptionPeriods).where(eq(stripeSubscriptionPeriods.invoiceId, 'in-1')).get())?.status).toBe('paid');
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

	test('a dispute queued before lifetime fulfillment releases the claimed slot', async () => {
		await testDb().db.insert(stripePendingReversals).values({ chargeId: 'ch-1', reason: 'dispute' });
		const result = await claimLifetimeSlot({ orgId: 'org-1', checkoutSessionId: 'cs-1', paymentIntentId: 'pi-1', chargeId: 'ch-1' });
		expect(result).toEqual({ slot: 1, status: 'released' });
		const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
		const slot = await testDb().db.select().from(stripeLifetimeSlots).where(eq(stripeLifetimeSlots.slot, 1)).get();
		expect(org?.plan).toBe('free');
		expect(slot?.activeOrgId).toBeNull();
	});


	test('a refund plus dispute releases the lifetime slot and entitlement', async () => {
		await testDb().db.insert(stripePendingReversals).values([{ chargeId: 'ch-1', reason: 'refund' }, { chargeId: 'ch-1', reason: 'dispute', disputeId: 'disp-1' }]);
		await testDb().db.insert(stripeDisputeReversals).values({ disputeId: 'disp-1', chargeId: 'ch-1', status: 'pending', source: 'unknown' });
		const result = await claimLifetimeSlot({ orgId: 'org-1', checkoutSessionId: 'cs-mixed', paymentIntentId: 'pi-1', chargeId: 'ch-1' });
		expect(result).toEqual({ slot: 1, status: 'released' });
		const slot = await testDb().db.select().from(stripeLifetimeSlots).where(eq(stripeLifetimeSlots.slot, 1)).get();
		const entitlement = await testDb().db.select().from(stripeLifetimeEntitlements).where(eq(stripeLifetimeEntitlements.checkoutSessionId, 'cs-mixed')).get();
		expect(slot?.activeOrgId).toBeNull();
		expect(slot?.activeEntitlementId).toBeNull();
		expect(entitlement?.status).toBe('released');
	});

	test('lifetime reversal requires matching payment and charge identifiers', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-2', name: 'org-2' });
		await claimLifetimeSlot({ orgId: 'org-1', checkoutSessionId: 'cs-a', paymentIntentId: 'pi-a', chargeId: 'ch-a' });
		await claimLifetimeSlot({ orgId: 'org-2', checkoutSessionId: 'cs-b', paymentIntentId: 'pi-b', chargeId: 'ch-b' });
		expect(await releaseLifetimeForPayment({ paymentIntentId: 'pi-a', chargeId: 'ch-b' })).toBe(false);
		const first = await testDb().db.select().from(stripeLifetimeEntitlements).where(eq(stripeLifetimeEntitlements.checkoutSessionId, 'cs-a')).get();
		expect(first?.status).toBe('active');
	});

	test('lifetime reversal rejects an ambiguous single identifier', async () => {
		await testDb().db.insert(organizations).values({ id: 'org-2', name: 'org-2' });
		await claimLifetimeSlot({ orgId: 'org-1', checkoutSessionId: 'cs-a', paymentIntentId: 'pi-a', chargeId: 'ch-same' });
		await claimLifetimeSlot({ orgId: 'org-2', checkoutSessionId: 'cs-b', paymentIntentId: 'pi-b', chargeId: 'ch-same' });
		await expect(releaseLifetimeForPayment({ chargeId: 'ch-same' })).rejects.toThrow('ambiguous');
	});
	test('a won dispute restores a disputed lifetime entitlement without releasing its slot', async () => {
		await claimLifetimeSlot({ orgId: 'org-1', checkoutSessionId: 'cs-1', paymentIntentId: 'pi-1', chargeId: 'ch-1' });
		expect(await revokeLifetimeForDispute({ paymentIntentId: 'pi-1', chargeId: 'ch-1' })).toBe(true);
		expect(await restoreLifetimeForDispute({ paymentIntentId: 'pi-1', chargeId: 'ch-1' })).toBe(true);
		const entitlement = await testDb().db.select().from(stripeLifetimeEntitlements).where(eq(stripeLifetimeEntitlements.checkoutSessionId, 'cs-1')).get();
		expect(entitlement?.status).toBe('active');
		expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.plan).toBe('lifetime');
	});


	test('a won dispute recorded before lifetime fulfillment keeps the slot active', async () => {
		await testDb().db.insert(stripePendingReversals).values({ chargeId: 'ch-1', reason: 'dispute', disputeId: 'disp-1' });
		await testDb().db.insert(stripeDisputeReversals).values({ disputeId: 'disp-1', chargeId: 'ch-1', paymentIntentId: 'pi-1', status: 'won', source: 'unknown' });
		expect(await claimLifetimeSlot({ orgId: 'org-1', checkoutSessionId: 'cs-1', paymentIntentId: 'pi-1', chargeId: 'ch-1' })).toMatchObject({ slot: 1, status: 'active' });
		expect((await testDb().db.select().from(stripeLifetimeEntitlements).where(eq(stripeLifetimeEntitlements.checkoutSessionId, 'cs-1')).get())?.status).toBe('active');
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
