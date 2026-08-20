import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	organizations,
	stripeLifetimeEntitlements,
	stripeLifetimeSlots,
	stripeSubscriptionPeriods,
	stripePendingReversals,
	stripeDisputeReversals
} from '$lib/server/db/schema';
import { HOSTED_INCLUDED_CREDITS } from './plans';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);
const LIFETIME_SOLD_OUT_ERROR = 'lifetime plan is sold out';
const LIFETIME_ENTITLEMENT_RECORD_ERROR = 'lifetime entitlement was not recorded';
const LIFETIME_SLOT_RACE_ERROR = 'lifetime slot claim lost its race';
const PAYMENT_REFERENCE_REQUIRED_ERROR = 'payment intent or charge id is required';

type PendingReversalState = {
	pending: Array<{ reason: string; disputeId: string | null }>;
	hasRefund: boolean;
	disputeId?: string;
	wonDispute: boolean;
};

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

async function pendingReversalState(tx: Tx, chargeId?: string): Promise<PendingReversalState> {
	if (!chargeId) return { pending: [], hasRefund: false, wonDispute: false };
	const pending = await tx.select({ reason: stripePendingReversals.reason, disputeId: stripePendingReversals.disputeId }).from(stripePendingReversals).where(eq(stripePendingReversals.chargeId, chargeId)).all();
	const hasRefund = pending.some((row) => row.reason === 'refund');
	const disputeId = pending.find((row) => row.reason === 'dispute' && row.disputeId)?.disputeId ?? undefined;
	const wonDispute = Boolean(disputeId && await tx.select({ id: stripeDisputeReversals.id }).from(stripeDisputeReversals).where(and(eq(stripeDisputeReversals.status, 'won'), eq(stripeDisputeReversals.disputeId, disputeId))).get());
	return { pending, hasRefund, disputeId, wonDispute };
}

/** Inserts one paid period and never grants it twice on webhook replay. */
export async function grantSubscriptionPeriod(input: SubscriptionPeriodGrant): Promise<boolean> {
	return db.transaction(async (tx) => {
		const org = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, input.orgId)).get();
		if (!org) throw new Error(`org not found: ${input.orgId}`);
		const reversal = await pendingReversalState(tx, input.chargeId);
		const periodStatus = reversal.hasRefund ? 'refunded' : reversal.wonDispute || !reversal.disputeId ? 'paid' : 'disputed';
		const inserted = await tx.insert(stripeSubscriptionPeriods).values({ orgId: input.orgId, subscriptionId: input.subscriptionId, invoiceId: input.invoiceId, paymentIntentId: input.paymentIntentId, chargeId: input.chargeId, periodKey: input.periodKey, periodStart: input.periodStart, periodEnd: input.periodEnd, includedCredits: HOSTED_INCLUDED_CREDITS, consumedCredits: 0, status: periodStatus }).onConflictDoNothing().returning({ id: stripeSubscriptionPeriods.id });
		if (reversal.pending.length && input.chargeId) await tx.delete(stripePendingReversals).where(eq(stripePendingReversals.chargeId, input.chargeId));
		if (reversal.disputeId) await tx.update(stripeDisputeReversals).set({ source: 'subscription', status: reversal.hasRefund ? 'ignored' : reversal.wonDispute ? 'restored' : 'reversed' }).where(eq(stripeDisputeReversals.disputeId, reversal.disputeId));
		await applySubscriptionSnapshotTx(tx, { orgId: input.orgId, subscriptionId: input.subscriptionId, status: 'active', periodStart: input.periodStart, periodEnd: input.periodEnd, cancelAtPeriodEnd: false, eventCreated: input.eventCreated, eventId: input.eventId });
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

async function applyPendingLifetimeReversal(tx: Tx, input: LifetimeClaim, slot: number, entitlementId: number, reversal: PendingReversalState): Promise<LifetimeClaimResult | undefined> {
	if (!input.chargeId || reversal.pending.length === 0 || reversal.wonDispute) return undefined;
	const pendingStatus: 'disputed' | 'released' = reversal.disputeId && !reversal.hasRefund ? 'disputed' : 'released';
	await tx.update(stripeLifetimeEntitlements).set({ status: pendingStatus, releasedAt: pendingStatus === 'released' ? sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` : null }).where(eq(stripeLifetimeEntitlements.id, entitlementId));
	if (!reversal.disputeId) await tx.update(stripeLifetimeSlots).set({ activeOrgId: null, activeEntitlementId: null, releasedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(eq(stripeLifetimeSlots.slot, slot));
	await tx.delete(stripePendingReversals).where(eq(stripePendingReversals.chargeId, input.chargeId));
	if (reversal.disputeId) await tx.update(stripeDisputeReversals).set({ source: 'lifetime', status: reversal.hasRefund ? 'ignored' : 'reversed' }).where(eq(stripeDisputeReversals.disputeId, reversal.disputeId));
	const subscription = await tx.select({ id: organizations.stripeSubscriptionId, status: organizations.stripeSubscriptionStatus }).from(organizations).where(eq(organizations.id, input.orgId)).get();
	const nextPlan = subscription?.id && subscription.status && ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status) ? 'hosted' : 'free';
	await tx.update(organizations).set({ plan: nextPlan }).where(eq(organizations.id, input.orgId));
	return { slot, status: pendingStatus === 'disputed' ? 'active' : 'released' };
}

/** Claims the lowest free slot inside the transaction that records the purchase. */
export async function claimLifetimeSlot(input: LifetimeClaim): Promise<LifetimeClaimResult> {
	return db.transaction(async (tx) => {
		const existing = await tx
			.select({ slot: stripeLifetimeEntitlements.slot, status: stripeLifetimeEntitlements.status })
			.from(stripeLifetimeEntitlements)
			.where(eq(stripeLifetimeEntitlements.checkoutSessionId, input.checkoutSessionId))
			.get();
		if (existing) return { slot: existing.slot, status: existing.status === 'released' ? 'released' : 'active' };
		const org = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, input.orgId)).get();
		if (!org) throw new Error(`org not found: ${input.orgId}`);
		const slot = await tx
			.select({ slot: stripeLifetimeSlots.slot })
			.from(stripeLifetimeSlots)
			.where(isNull(stripeLifetimeSlots.activeOrgId))
			.orderBy(asc(stripeLifetimeSlots.slot))
			.limit(1)
			.get();
		if (!slot) throw new Error(LIFETIME_SOLD_OUT_ERROR);
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
		if (inserted.length !== 1) throw new Error(LIFETIME_ENTITLEMENT_RECORD_ERROR);
		const claimed = await tx
			.update(stripeLifetimeSlots)
			.set({ activeOrgId: input.orgId, activeEntitlementId: inserted[0].id, claimedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, releasedAt: null })
			.where(and(eq(stripeLifetimeSlots.slot, slot.slot), isNull(stripeLifetimeSlots.activeOrgId)))
			.returning({ slot: stripeLifetimeSlots.slot });
		if (claimed.length !== 1) throw new Error(LIFETIME_SLOT_RACE_ERROR);
		const reversal = await pendingReversalState(tx, input.chargeId);
		const pendingResult = await applyPendingLifetimeReversal(tx, input, slot.slot, inserted[0].id, reversal);
		if (pendingResult) return pendingResult;
		if (reversal.wonDispute) {
			if (reversal.disputeId) await tx.update(stripeDisputeReversals).set({ source: 'lifetime', status: 'restored' }).where(eq(stripeDisputeReversals.disputeId, reversal.disputeId));
			if (input.chargeId) await tx.delete(stripePendingReversals).where(eq(stripePendingReversals.chargeId, input.chargeId));
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
	if (matches.length === 0) throw new Error(PAYMENT_REFERENCE_REQUIRED_ERROR);
	return db.transaction(async (tx) => {
		const entitlement = await tx
			.select({ id: stripeLifetimeEntitlements.id, orgId: stripeLifetimeEntitlements.orgId, slot: stripeLifetimeEntitlements.slot, status: stripeLifetimeEntitlements.status })
			.from(stripeLifetimeEntitlements)
			.where(or(...matches))
			.get();
		if (!entitlement) return false;
		if (entitlement.status === 'released') return true;
		if (entitlement.status !== 'active' && entitlement.status !== 'disputed') return true;
		await tx.update(stripeLifetimeEntitlements).set({ status: 'released', releasedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(eq(stripeLifetimeEntitlements.id, entitlement.id));
		await tx.update(stripeLifetimeSlots).set({ activeOrgId: null, activeEntitlementId: null, releasedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(and(eq(stripeLifetimeSlots.slot, entitlement.slot), eq(stripeLifetimeSlots.activeOrgId, entitlement.orgId)));
		const sub = await tx.select({ id: organizations.stripeSubscriptionId, status: organizations.stripeSubscriptionStatus }).from(organizations).where(eq(organizations.id, entitlement.orgId)).get();
		const nextPlan = sub?.id && sub.status && ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status) ? 'hosted' : 'free';
		await tx.update(organizations).set({ plan: nextPlan }).where(eq(organizations.id, entitlement.orgId));
		return true;
	});
}


export async function revokeLifetimeForDispute(input: { paymentIntentId?: string; chargeId?: string }): Promise<boolean> {
	const matches = [
		input.paymentIntentId ? eq(stripeLifetimeEntitlements.paymentIntentId, input.paymentIntentId) : undefined,
		input.chargeId ? eq(stripeLifetimeEntitlements.chargeId, input.chargeId) : undefined
	].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
	if (matches.length === 0) throw new Error(PAYMENT_REFERENCE_REQUIRED_ERROR);
	return db.transaction(async (tx) => {
		const entitlement = await tx.select({ id: stripeLifetimeEntitlements.id, orgId: stripeLifetimeEntitlements.orgId, status: stripeLifetimeEntitlements.status }).from(stripeLifetimeEntitlements).where(or(...matches)).get();
		if (!entitlement) return false;
		if (entitlement.status === 'disputed') return true;
		if (entitlement.status !== 'active') return false;
		await tx.update(stripeLifetimeEntitlements).set({ status: 'disputed' }).where(eq(stripeLifetimeEntitlements.id, entitlement.id));
		const sub = await tx.select({ id: organizations.stripeSubscriptionId, status: organizations.stripeSubscriptionStatus }).from(organizations).where(eq(organizations.id, entitlement.orgId)).get();
		const nextPlan = sub?.id && sub.status && ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status) ? 'hosted' : 'free';
		await tx.update(organizations).set({ plan: nextPlan }).where(eq(organizations.id, entitlement.orgId));
		return true;
	});
}

export async function restoreLifetimeForDispute(input: { paymentIntentId?: string; chargeId?: string }): Promise<boolean> {
	const matches = [
		input.paymentIntentId ? eq(stripeLifetimeEntitlements.paymentIntentId, input.paymentIntentId) : undefined,
		input.chargeId ? eq(stripeLifetimeEntitlements.chargeId, input.chargeId) : undefined
	].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
	if (matches.length === 0) throw new Error(PAYMENT_REFERENCE_REQUIRED_ERROR);
	return db.transaction(async (tx) => {
		const entitlement = await tx.select({ id: stripeLifetimeEntitlements.id, orgId: stripeLifetimeEntitlements.orgId }).from(stripeLifetimeEntitlements).where(and(eq(stripeLifetimeEntitlements.status, 'disputed'), or(...matches))).get();
		if (!entitlement) return false;
		await tx.update(stripeLifetimeEntitlements).set({ status: 'active', releasedAt: null }).where(eq(stripeLifetimeEntitlements.id, entitlement.id));
		await tx.update(organizations).set({ plan: 'lifetime' }).where(eq(organizations.id, entitlement.orgId));
		return true;
	});
}

export async function restoreDisputedSubscriptionPeriod(input: { paymentIntentId?: string; chargeId?: string }): Promise<boolean> {
	const matches = [
		input.paymentIntentId ? eq(stripeSubscriptionPeriods.paymentIntentId, input.paymentIntentId) : undefined,
		input.chargeId ? eq(stripeSubscriptionPeriods.chargeId, input.chargeId) : undefined
	].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
	if (matches.length === 0) throw new Error(PAYMENT_REFERENCE_REQUIRED_ERROR);
	const changed = await db.update(stripeSubscriptionPeriods).set({ status: 'paid' }).where(and(eq(stripeSubscriptionPeriods.status, 'disputed'), or(...matches))).returning({ id: stripeSubscriptionPeriods.id });
	return changed.length > 0;
}


/** Marks the paid subscription period behind a full refund unusable. */
export async function refundSubscriptionPeriod(input: { paymentIntentId?: string; chargeId?: string }): Promise<boolean> {
	const matches = [
		input.paymentIntentId ? eq(stripeSubscriptionPeriods.paymentIntentId, input.paymentIntentId) : undefined,
		input.chargeId ? eq(stripeSubscriptionPeriods.chargeId, input.chargeId) : undefined
	].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
	if (matches.length === 0) throw new Error(PAYMENT_REFERENCE_REQUIRED_ERROR);
	const existing = await db.select({ status: stripeSubscriptionPeriods.status }).from(stripeSubscriptionPeriods).where(or(...matches)).get();
	if (!existing) return false;
	if (existing.status !== 'paid' && existing.status !== 'disputed') return true;
	const changed = await db
		.update(stripeSubscriptionPeriods)
		.set({ status: 'refunded' })
		.where(and(or(eq(stripeSubscriptionPeriods.status, 'paid'), eq(stripeSubscriptionPeriods.status, 'disputed')), or(...matches)))
		.returning({ id: stripeSubscriptionPeriods.id });
	return changed.length > 0;
}


/** Marks a paid subscription period unusable after a card dispute. */
export async function disputeSubscriptionPeriod(input: { paymentIntentId?: string; chargeId?: string }): Promise<boolean> {
	const matches = [
		input.paymentIntentId ? eq(stripeSubscriptionPeriods.paymentIntentId, input.paymentIntentId) : undefined,
		input.chargeId ? eq(stripeSubscriptionPeriods.chargeId, input.chargeId) : undefined
	].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
	if (matches.length === 0) throw new Error(PAYMENT_REFERENCE_REQUIRED_ERROR);
	const existing = await db.select({ status: stripeSubscriptionPeriods.status }).from(stripeSubscriptionPeriods).where(or(...matches)).get();
	if (existing && existing.status !== 'paid') return true;
	const changed = await db
		.update(stripeSubscriptionPeriods)
		.set({ status: 'disputed' })
		.where(and(eq(stripeSubscriptionPeriods.status, 'paid'), or(...matches)))
		.returning({ id: stripeSubscriptionPeriods.id });
	return changed.length > 0;
}
