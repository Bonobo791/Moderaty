import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import { db } from '$lib/server/db';
import { organizations, stripeAutoTopupRecoveries } from '$lib/server/db/schema';
import type { LedgerHandle } from './ledger';
import { getStripe } from '$lib/server/stripe/client';
import { refundUngrantablePayment } from '$lib/server/stripe/refunds';

type Recovery = typeof stripeAutoTopupRecoveries.$inferSelect;
export interface TopupPayment {
	id: string;
	status?: string | null;
	created?: number | null;
	metadata: Record<string, string> | null;
}

class InvalidTopupPayment extends Error {}

/** Round-trip validation rejects noncanonical or impossible provider dates. */
function validatedAttemptTime(value: unknown, dayOnly = false): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new InvalidTopupPayment('Auto top-up payment has an invalid attempt date');
	const iso = new Date(value).toISOString();
	if ((dayOnly ? iso.slice(0, 10) : iso) !== value) throw new InvalidTopupPayment('Auto top-up payment has an invalid attempt date');
	return value;
}

/** Exact identity for new attempts; daily/time correlation only for older payments. */
export function topupAttemptCorrelation(pi: TopupPayment, column: AnySQLiteColumn) {
	const attemptAt = validatedAttemptTime(pi.metadata?.auto_topup_attempt_at);
	const attemptDay = validatedAttemptTime(pi.metadata?.auto_topup_attempt_day, true);
	if (attemptAt) return eq(column, attemptAt);
	if (attemptDay) return sql`substr(${column}, 1, 10) = ${attemptDay}`;
	if (pi.created == null) return undefined;
	if (!Number.isSafeInteger(pi.created) || pi.created <= 0 || !Number.isFinite(new Date(pi.created * 1000).getTime())) throw new InvalidTopupPayment('Auto top-up payment has an invalid creation timestamp');
	return and(gte(column, new Date(pi.created * 1000 - 60_000).toISOString()), lte(column, new Date(pi.created * 1000 + 60_000).toISOString()));
}

/** Prefer a bound PaymentIntent; never correlate a different payment to that row. */
export async function findPausedTopup(handle: LedgerHandle, orgId: string, pi: TopupPayment): Promise<Recovery | undefined> {
	const correlation = topupAttemptCorrelation(pi, stripeAutoTopupRecoveries.attemptAt);
	const known = await handle.select().from(stripeAutoTopupRecoveries).where(and(eq(stripeAutoTopupRecoveries.orgId, orgId), eq(stripeAutoTopupRecoveries.paymentIntentId, pi.id))).get();
	if (known) return known;
	if (!correlation) {
		const pending = await handle.select({ id: stripeAutoTopupRecoveries.id }).from(stripeAutoTopupRecoveries).where(and(eq(stripeAutoTopupRecoveries.orgId, orgId), isNull(stripeAutoTopupRecoveries.resolvedAt))).get();
		if (pending) throw new Error(`auto top-up ${pi.id} cannot be correlated to a canceled attempt`);
		return undefined;
	}
	const rows = await handle.select().from(stripeAutoTopupRecoveries).where(and(eq(stripeAutoTopupRecoveries.orgId, orgId), isNull(stripeAutoTopupRecoveries.paymentIntentId), correlation)).limit(2).all();
	if (rows.length > 1) throw new Error(`auto top-up ${pi.id} matches multiple canceled attempts`);
	return rows[0];
}

/** Persist the refund identity until Stripe confirms its terminal outcome. */
async function cancelOrRefund(row: Recovery, pi: TopupPayment): Promise<boolean> {
	if (pi.status === 'canceled') return true;
	if (pi.status !== 'succeeded') {
		if (!['requires_payment_method', 'requires_capture', 'requires_confirmation', 'requires_action', 'processing'].includes(pi.status ?? '')) throw new InvalidTopupPayment('Canceled auto top-up has an invalid payment status');
		const canceled = await getStripe().paymentIntents.cancel(pi.id, { cancellation_reason: 'requested_by_customer' });
		if (canceled.status !== 'canceled') throw new Error('Auto top-up cancellation did not complete');
		return true;
	}
	const refund = row.refundId
		? await getStripe().refunds.retrieve(row.refundId)
		: await refundUngrantablePayment({ paymentIntentId: pi.id, orgId: row.orgId, idempotencyKey: `refund:autotopup-paused:${pi.id}`, label: `auto top-up ${pi.id} overlapped a refund pause` });
	if (!refund.id || !['succeeded', 'pending', 'requires_action'].includes(refund.status ?? '')) throw new Error('MANUAL REFUND REQUIRED: canceled auto top-up refund failed');
	await db.update(stripeAutoTopupRecoveries).set({ refundId: refund.id }).where(eq(stripeAutoTopupRecoveries.id, row.id));
	return refund.status === 'succeeded';
}

/** Returns true only when the cancellation/refund is finished. Never grants credits. */
export async function recoverPausedTopup(row: Recovery, pi: TopupPayment): Promise<boolean> {
	if (pi.metadata?.type !== 'auto_topup' || pi.metadata.org_id !== row.orgId) throw new Error('Canceled auto top-up payment has invalid organization metadata');
	const predicate = eq(stripeAutoTopupRecoveries.id, row.id);
	const current = await db.select().from(stripeAutoTopupRecoveries).where(predicate).get();
	if (!current) throw new Error('Canceled auto top-up recovery was not found');
	if (current.paymentIntentId && current.paymentIntentId !== pi.id) throw new Error('Canceled auto top-up has a different payment intent');
	if (current.resolvedAt) return true;
	const bound = await db.update(stripeAutoTopupRecoveries).set({ paymentIntentId: pi.id, lastCheckedAt: new Date().toISOString() }).where(and(predicate, or(isNull(stripeAutoTopupRecoveries.paymentIntentId), eq(stripeAutoTopupRecoveries.paymentIntentId, pi.id)))).returning({ id: stripeAutoTopupRecoveries.id });
	if (!bound.length) throw new Error('Canceled auto top-up was bound to another payment');
	try {
		const resolved = await cancelOrRefund(current, pi);
		await db.update(stripeAutoTopupRecoveries).set({ lastError: null, ...(resolved ? { resolvedAt: new Date().toISOString() } : {}) }).where(predicate);
		return resolved;
	} catch (error) {
		const failed = await db.update(stripeAutoTopupRecoveries).set({ lastError: 'refund_or_cancellation_failed' }).where(and(predicate, isNull(stripeAutoTopupRecoveries.resolvedAt))).returning({ id: stripeAutoTopupRecoveries.id });
		if (!failed.length && (await db.select().from(stripeAutoTopupRecoveries).where(predicate).get())?.resolvedAt) return true;
		console.error('auto top-up recovery failed — retry or manual refund required', { orgId: row.orgId, paymentIntentId: pi.id }, error);
		throw error;
	}
}

/** Validate and correlate one list item before any remote mutation. */
async function recoverCandidate(row: Recovery, pi: TopupPayment | null): Promise<boolean> {
	if (!pi || typeof pi.id !== 'string' || !pi.id || !['succeeded', 'canceled', 'requires_payment_method', 'requires_capture', 'requires_confirmation', 'requires_action', 'processing'].includes(pi.status ?? '')) throw new InvalidTopupPayment('Malformed payment intent');
	if (pi.metadata?.type !== 'auto_topup' || pi.metadata.org_id !== row.orgId) return false;
	const match = await findPausedTopup(db, row.orgId, pi);
	if (match?.id !== row.id) return false;
	await recoverPausedTopup(row, pi);
	return true;
}

/** A malformed item cannot hide the matching payment later in Stripe's list. */
async function recoverListedPayment(row: Recovery): Promise<void> {
	const customerId = row.customerId ?? (await db.select({ customerId: organizations.stripeCustomerId }).from(organizations).where(eq(organizations.id, row.orgId)).get())?.customerId;
	if (!customerId) throw new Error('Canceled auto top-up organization has no Stripe customer');
	const attemptMs = Date.parse(row.attemptAt);
	if (!Number.isFinite(attemptMs)) throw new Error('Canceled auto top-up has an invalid attempt timestamp');
	const list = await getStripe().paymentIntents.list({ customer: customerId, created: { gte: Math.floor((attemptMs - 60_000) / 1000) }, limit: 100 });
	if (!Array.isArray(list.data)) throw new Error('Stripe returned an invalid payment intent list');
	let skipped = 0;
	let found = false;
	for (const pi of list.data) {
		try {
			found = await recoverCandidate(row, pi);
			if (found) break;
		} catch (error) {
			if (!(error instanceof InvalidTopupPayment)) throw error;
			skipped++;
		}
	}
	if (skipped) console.error('auto top-up recovery skipped malformed payment items', { orgId: row.orgId, skipped });
	if (!found) throw new Error(list.has_more ? 'Canceled auto top-up lookup needs manual reconciliation: payment list truncated' : 'Canceled auto top-up payment not found yet — retry or manual reconciliation required');
}

/** Count attempted work (including failures), excluding rows skipped at the deadline. */
export async function sweepPausedTopups(limit: number, deadline?: number): Promise<number> {
	const rows = await db.select().from(stripeAutoTopupRecoveries).where(isNull(stripeAutoTopupRecoveries.resolvedAt)).orderBy(asc(stripeAutoTopupRecoveries.lastCheckedAt), asc(stripeAutoTopupRecoveries.id)).limit(limit).all();
	let attempted = 0;
	for (const row of rows) {
		if (deadline !== undefined && Date.now() >= deadline) break;
		attempted++;
		const predicate = and(eq(stripeAutoTopupRecoveries.id, row.id), isNull(stripeAutoTopupRecoveries.resolvedAt));
		await db.update(stripeAutoTopupRecoveries).set({ lastCheckedAt: new Date().toISOString() }).where(predicate);
		try {
			if (row.paymentIntentId) await recoverPausedTopup(row, await getStripe().paymentIntents.retrieve(row.paymentIntentId));
			else await recoverListedPayment(row);
		} catch (error) {
			await db.update(stripeAutoTopupRecoveries).set({ lastError: 'refund_or_cancellation_failed' }).where(predicate);
			console.error('auto top-up recovery sweep failed', { orgId: row.orgId }, error);
		}
	}
	return attempted;
}
