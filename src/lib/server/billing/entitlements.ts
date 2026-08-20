import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	organizations,
	stripeLifetimeEntitlements,
	stripeLifetimeSlots,
	stripeSubscriptionPeriods,
	stripePendingReversals
} from '$lib/server/db/schema';
import { HOSTED_INCLUDED_CREDITS } from './plans';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

function isNewerEvent(
	currentCreated: number | null | undefined,
	currentId: string | null | undefined,
	eventCreated: number,
	eventId: string
): boolean {
	if (currentCreated === null || currentCreated === undefined) return true;
	return eventCreated > currentCreated || (eventCreated === currentCreated && eventId > (currentId ?? ''));
}

async function hasActiveLifetime(tx: Tx, orgId: string): Promise<boolean> {
	const row = await tx
		.select({ id: stripeLifetimeEntitlements.id })
		.from(stripeLifetimeEntitlements)
		.where(and(eq(stripeLifetimeEntitlements.orgId, orgId), eq(stripeLifetimeEntitlements.status, 'active')))
		.get();
	return Boolean(row);
}

async function applySubscriptionSnapshotTx(tx: Tx, snapshot: SubscriptionSnapshot): Promise<boolean> {
	const org = await tx
		.select({
			id: organizations.id,
			lastCreated: organizations.stripeSubscriptionLastEventCreated,
			lastId: organizations.stripeSubscriptionLastEventId
		})
		.from(organizations)
		.where(eq(organizations.id, snapshot.orgId))
		.get();
	if (!org) throw new Error(`org not found: ${snapshot.orgId}`);
	if (!isNewerEvent(org.lastCreated, org.lastId, snapshot.eventCreated, snapshot.eventId)) return false;
	const lifetime = await hasActiveLifetime(tx, snapshot.orgId);
	const cachedPlan = lifetime ? 'lifetime' : ACTIVE_SUBSCRIPTION_STATUSES.has(snapshot.status) ? 'hosted' : 'free';
	await tx
		.update(organizations)
		.set({
			plan: cachedPlan,
			stripeSubscriptionId: snapshot.subscriptionId,
			stripeSubscriptionStatus: snapshot.status,
			stripeSubscriptionPeriodStart: snapshot.periodStart,
			stripeSubscriptionPeriodEnd: snapshot.periodEnd,
			stripeSubscriptionCancelAtPeriodEnd: snapshot.cancelAtPeriodEnd ? 1 : 0,
			stripeSubscriptionLastEventCreated: snapshot.eventCreated,
			stripeSubscriptionLastEventId: snapshot.eventId
		})
		.where(eq(organizations.id, snapshot.orgId));
	return true;
}

export interface SubscriptionSnapshot {
	orgId: string;
	subscriptionId: string;
	status: string;
	periodStart: string;
	periodEnd: string;
	cancelAtPeriodEnd: boolean;
	eventCreated: number;
	eventId: string;
}

export async function applySubscriptionSnapshot(snapshot: SubscriptionSnapshot): Promise<boolean> {
	return db.transaction((tx) => applySubscriptionSnapshotTx(tx, snapshot));
}

export interface SubscriptionPeriodGrant {
	orgId: string;
	subscriptionId: string;
	invoiceId: string;
	paymentIntentId?: string;
	chargeId?: string;
	periodKey: string;
	periodStart: string;
	periodEnd: string;
	eventCreated: number;
	eventId: string;
}

/** Inserts one paid period and never grants it twice on webhook replay. */
export async function grantSubscriptionPeriod(input: SubscriptionPeriodGrant): Promise<boolean> {
	return db.transaction(async (tx) => {
		const org = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, input.orgId)).get();
		if (!org) throw new Error(`org not found: ${input.orgId}`);
		const pending = input.chargeId
			? await tx.select({ reason: stripePendingReversals.reason }).from(stripePendingReversals).where(eq(stripePendingReversals.chargeId, input.chargeId)).all()
			: [];
		const periodStatus = pending.some((row) => row.reason === 'dispute') ? 'disputed' : pending.length ? 'refunded' : 'paid';
		const inserted = await tx
			.insert(stripeSubscriptionPeriods)
			.values({
				orgId: input.orgId,
				subscriptionId: input.subscriptionId,
				invoiceId: input.invoiceId,
				paymentIntentId: input.paymentIntentId,
				chargeId: input.chargeId,
				periodKey: input.periodKey,
				periodStart: input.periodStart,
				periodEnd: input.periodEnd,
				includedCredits: HOSTED_INCLUDED_CREDITS,
				consumedCredits: 0,
				status: periodStatus
			})
			.onConflictDoNothing()
			.returning({ id: stripeSubscriptionPeriods.id });
		if (pending.length && input.chargeId) await tx.delete(stripePendingReversals).where(eq(stripePendingReversals.chargeId, input.chargeId));
		await applySubscriptionSnapshotTx(tx, {
			orgId: input.orgId,
			subscriptionId: input.subscriptionId,
			status: 'active',
			periodStart: input.periodStart,
			periodEnd: input.periodEnd,
			cancelAtPeriodEnd: false,
			eventCreated: input.eventCreated,
			eventId: input.eventId
		});
		return inserted.length > 0;
	});
}

export interface LifetimeClaim {
	orgId: string;
	checkoutSessionId: string;
	paymentIntentId?: string;
	chargeId?: string;
}

export interface LifetimeClaimResult {
	slot: number;
	status: 'active' | 'released';
}

/** Claims the lowest free slot inside the transaction that records the purchase. */
export async function claimLifetimeSlot(input: LifetimeClaim): Promise<LifetimeClaimResult> {
	return db.transaction(async (tx) => {
		const existing = await tx
			.select({ slot: stripeLifetimeEntitlements.slot, status: stripeLifetimeEntitlements.status })
			.from(stripeLifetimeEntitlements)
			.where(eq(stripeLifetimeEntitlements.checkoutSessionId, input.checkoutSessionId))
			.get();
		if (existing) return { slot: existing.slot, status: existing.status as 'active' | 'released' };
		const org = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, input.orgId)).get();
		if (!org) throw new Error(`org not found: ${input.orgId}`);
		const slot = await tx
			.select({ slot: stripeLifetimeSlots.slot })
			.from(stripeLifetimeSlots)
			.where(isNull(stripeLifetimeSlots.activeOrgId))
			.orderBy(asc(stripeLifetimeSlots.slot))
			.limit(1)
			.get();
		if (!slot) throw new Error('lifetime plan is sold out');
		const inserted = await tx
			.insert(stripeLifetimeEntitlements)
			.values({
				orgId: input.orgId,
				slot: slot.slot,
				checkoutSessionId: input.checkoutSessionId,
				paymentIntentId: input.paymentIntentId,
				chargeId: input.chargeId,
				status: 'active'
			})
			.returning({ id: stripeLifetimeEntitlements.id });
		if (inserted.length !== 1) throw new Error('lifetime entitlement was not recorded');
		const claimed = await tx
			.update(stripeLifetimeSlots)
			.set({ activeOrgId: input.orgId, activeEntitlementId: inserted[0].id, claimedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, releasedAt: null })
			.where(and(eq(stripeLifetimeSlots.slot, slot.slot), isNull(stripeLifetimeSlots.activeOrgId)))
			.returning({ slot: stripeLifetimeSlots.slot });
		if (claimed.length !== 1) throw new Error('lifetime slot claim lost its race');
		const pending = input.chargeId
			? await tx.select({ reason: stripePendingReversals.reason }).from(stripePendingReversals).where(eq(stripePendingReversals.chargeId, input.chargeId)).all()
			: [];
		if (pending.length && input.chargeId) {
			await tx.update(stripeLifetimeEntitlements).set({ status: 'released', releasedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(eq(stripeLifetimeEntitlements.id, inserted[0].id));
			await tx.update(stripeLifetimeSlots).set({ activeOrgId: null, activeEntitlementId: null, releasedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(eq(stripeLifetimeSlots.slot, slot.slot));
			await tx.delete(stripePendingReversals).where(eq(stripePendingReversals.chargeId, input.chargeId));
			const subscription = await tx.select({ id: organizations.stripeSubscriptionId, status: organizations.stripeSubscriptionStatus }).from(organizations).where(eq(organizations.id, input.orgId)).get();
			const nextPlan = subscription?.id && subscription.status && ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status) ? 'hosted' : 'free';
			await tx.update(organizations).set({ plan: nextPlan }).where(eq(organizations.id, input.orgId));
			return { slot: slot.slot, status: 'released' };
		}
		await tx.update(organizations).set({ plan: 'lifetime' }).where(eq(organizations.id, input.orgId));
		return { slot: slot.slot, status: 'active' };
	});
}

export async function releaseLifetimeForPayment(input: { paymentIntentId?: string; chargeId?: string }): Promise<boolean> {
	const matches = [
		input.paymentIntentId ? eq(stripeLifetimeEntitlements.paymentIntentId, input.paymentIntentId) : undefined,
		input.chargeId ? eq(stripeLifetimeEntitlements.chargeId, input.chargeId) : undefined
	].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
	if (matches.length === 0) throw new Error('payment intent or charge id is required');
	return db.transaction(async (tx) => {
		const entitlement = await tx
			.select({ id: stripeLifetimeEntitlements.id, orgId: stripeLifetimeEntitlements.orgId, slot: stripeLifetimeEntitlements.slot })
			.from(stripeLifetimeEntitlements)
			.where(and(eq(stripeLifetimeEntitlements.status, 'active'), or(...matches)))
			.get();
		if (!entitlement) return false;
		await tx.update(stripeLifetimeEntitlements).set({ status: 'released', releasedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(eq(stripeLifetimeEntitlements.id, entitlement.id));
		await tx.update(stripeLifetimeSlots).set({ activeOrgId: null, activeEntitlementId: null, releasedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(and(eq(stripeLifetimeSlots.slot, entitlement.slot), eq(stripeLifetimeSlots.activeOrgId, entitlement.orgId)));
		const sub = await tx.select({ id: organizations.stripeSubscriptionId, status: organizations.stripeSubscriptionStatus }).from(organizations).where(eq(organizations.id, entitlement.orgId)).get();
		const nextPlan = sub?.id && sub.status && ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status) ? 'hosted' : 'free';
		await tx.update(organizations).set({ plan: nextPlan }).where(eq(organizations.id, entitlement.orgId));
		return true;
	});
}


/** Marks the paid subscription period behind a full refund unusable. */
export async function refundSubscriptionPeriod(input: { paymentIntentId?: string; chargeId?: string }): Promise<boolean> {
	const matches = [
		input.paymentIntentId ? eq(stripeSubscriptionPeriods.paymentIntentId, input.paymentIntentId) : undefined,
		input.chargeId ? eq(stripeSubscriptionPeriods.chargeId, input.chargeId) : undefined
	].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
	if (matches.length === 0) throw new Error('payment intent or charge id is required');
	const changed = await db
		.update(stripeSubscriptionPeriods)
		.set({ status: 'refunded' })
		.where(and(eq(stripeSubscriptionPeriods.status, 'paid'), or(...matches)))
		.returning({ id: stripeSubscriptionPeriods.id });
	return changed.length > 0;
}


/** Marks a paid subscription period unusable after a card dispute. */
export async function disputeSubscriptionPeriod(input: { paymentIntentId?: string; chargeId?: string }): Promise<boolean> {
	const matches = [
		input.paymentIntentId ? eq(stripeSubscriptionPeriods.paymentIntentId, input.paymentIntentId) : undefined,
		input.chargeId ? eq(stripeSubscriptionPeriods.chargeId, input.chargeId) : undefined
	].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
	if (matches.length === 0) throw new Error('payment intent or charge id is required');
	const changed = await db
		.update(stripeSubscriptionPeriods)
		.set({ status: 'disputed' })
		.where(and(eq(stripeSubscriptionPeriods.status, 'paid'), or(...matches)))
		.returning({ id: stripeSubscriptionPeriods.id });
	return changed.length > 0;
}
