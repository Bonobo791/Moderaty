import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';

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

/** Stable daily identity for new attempts; existing time correlation for legacy PIs. */
export async function findPausedTopup(handle: LedgerHandle, orgId: string, pi: TopupPayment): Promise<Recovery | undefined> {
	const attemptDay = pi.metadata?.auto_topup_attempt_day;
	if (attemptDay && (!/^\d{4}-\d{2}-\d{2}$/.test(attemptDay) || !Number.isFinite(Date.parse(attemptDay)) || new Date(attemptDay).toISOString().slice(0, 10) !== attemptDay)) throw new Error('Auto top-up payment has an invalid attempt date');
	const createdMs = typeof pi.created === 'number' && Number.isFinite(pi.created) && pi.created > 0 ? pi.created * 1000 : undefined;
	// ponytail: one charge/day; persist individual attempt IDs if the daily cap changes.
	const correlation = attemptDay ? sql`substr(${stripeAutoTopupRecoveries.attemptAt}, 1, 10) = ${attemptDay}` : createdMs ? and(
		gte(stripeAutoTopupRecoveries.attemptAt, new Date(createdMs - 60_000).toISOString()),
		lte(stripeAutoTopupRecoveries.attemptAt, new Date(createdMs + 60_000).toISOString())
	) : undefined;
	const rows = await handle.select().from(stripeAutoTopupRecoveries).where(and(
		eq(stripeAutoTopupRecoveries.orgId, orgId),
		or(eq(stripeAutoTopupRecoveries.paymentIntentId, pi.id), correlation)
	)).limit(2).all();
	if (rows.length > 1) throw new Error(`auto top-up ${pi.id} matches multiple canceled attempts`);
	if (!rows.length && !correlation) {
		const pending = await handle.select({ id: stripeAutoTopupRecoveries.id }).from(stripeAutoTopupRecoveries)
			.where(and(eq(stripeAutoTopupRecoveries.orgId, orgId), isNull(stripeAutoTopupRecoveries.resolvedAt))).get();
		if (pending) throw new Error(`auto top-up ${pi.id} cannot be correlated to a canceled attempt`);
	}
	return rows[0];
}

/** Returns true only when the cancellation/refund is finished. Never grants credits. */
export async function recoverPausedTopup(row: Recovery, pi: TopupPayment): Promise<boolean> {
	if (pi.metadata?.type !== 'auto_topup' || pi.metadata.org_id !== row.orgId) throw new Error('Canceled auto top-up payment has invalid organization metadata');
	if (row.paymentIntentId && row.paymentIntentId !== pi.id) throw new Error('Canceled auto top-up has a different payment intent');
	const predicate = eq(stripeAutoTopupRecoveries.id, row.id);
	const current = await db.select().from(stripeAutoTopupRecoveries).where(predicate).get();
	if (!current) throw new Error('Canceled auto top-up recovery was not found');
	if (current.resolvedAt) return true;
	await db.update(stripeAutoTopupRecoveries).set({ paymentIntentId: pi.id, lastCheckedAt: new Date().toISOString() }).where(predicate);
	try {
		let resolved = pi.status === 'canceled';
		if (pi.status === 'succeeded') {
			const refund = current.refundId
				? await getStripe().refunds.retrieve(current.refundId)
				: await refundUngrantablePayment({ paymentIntentId: pi.id, orgId: row.orgId,
					idempotencyKey: `refund:autotopup-paused:${pi.id}`, label: `auto top-up ${pi.id} overlapped a refund pause` });
			await db.update(stripeAutoTopupRecoveries).set({ refundId: refund.id }).where(predicate);
			if (refund.status !== 'succeeded' && refund.status !== 'pending' && refund.status !== 'requires_action') throw new Error('MANUAL REFUND REQUIRED: canceled auto top-up refund failed');
			resolved = refund.status === 'succeeded';
		} else if (!resolved) {
			if (!['requires_payment_method', 'requires_capture', 'requires_confirmation', 'requires_action', 'processing'].includes(pi.status ?? '')) throw new Error('Canceled auto top-up has an invalid payment status');
			const canceled = await getStripe().paymentIntents.cancel(pi.id, { cancellation_reason: 'requested_by_customer' });
			if (canceled.status !== 'canceled') throw new Error('Auto top-up cancellation did not complete');
			resolved = true;
		}
		await db.update(stripeAutoTopupRecoveries).set({ lastError: null, ...(resolved ? { resolvedAt: new Date().toISOString() } : {}) }).where(predicate);
		return resolved;
	} catch (error) {
		await db.update(stripeAutoTopupRecoveries).set({ lastError: 'refund_or_cancellation_failed' }).where(predicate);
		console.error(`auto top-up recovery failed for org ${row.orgId}, payment ${pi.id} — retry or manual refund required`, error);
		throw error;
	}
}

/** Recovery runs even for disabled orgs and retains obligations beyond webhook retry windows. */
export async function sweepPausedTopups(limit: number, deadline?: number): Promise<number> {
	const rows = await db.select().from(stripeAutoTopupRecoveries).where(isNull(stripeAutoTopupRecoveries.resolvedAt))
		.orderBy(asc(stripeAutoTopupRecoveries.lastCheckedAt), asc(stripeAutoTopupRecoveries.id)).limit(limit).all();
	for (const row of rows) {
		if (deadline !== undefined && Date.now() >= deadline) break;
		const predicate = eq(stripeAutoTopupRecoveries.id, row.id);
		await db.update(stripeAutoTopupRecoveries).set({ lastCheckedAt: new Date().toISOString() }).where(predicate);
		try {
			if (row.paymentIntentId) {
				await recoverPausedTopup(row, await getStripe().paymentIntents.retrieve(row.paymentIntentId));
				continue;
			}
			const org = await db.select({ customerId: organizations.stripeCustomerId }).from(organizations).where(eq(organizations.id, row.orgId)).get();
			if (!org?.customerId) throw new Error('Canceled auto top-up organization has no Stripe customer');
			const attemptMs = Date.parse(row.attemptAt);
			if (!Number.isFinite(attemptMs)) throw new Error('Canceled auto top-up has an invalid attempt timestamp');
			const list = await getStripe().paymentIntents.list({ customer: org.customerId, created: { gte: Math.floor((attemptMs - 60_000) / 1000) }, limit: 100 });
			if (!Array.isArray(list.data)) throw new Error('Stripe returned an invalid payment intent list');
			let found = false;
			let skipped = 0;
			for (const pi of list.data) {
				if (!pi || typeof pi.id !== 'string' || !pi.id || typeof pi.status !== 'string') {
					skipped++;
					continue;
				}
				if (pi.metadata?.type !== 'auto_topup' || pi.metadata.org_id !== row.orgId) continue;
				const match = await findPausedTopup(db, row.orgId, pi);
				if (match?.id !== row.id) continue;
				found = true;
				await recoverPausedTopup(row, pi);
			}
			if (skipped) console.error(`auto top-up recovery skipped ${skipped} malformed payment item(s) for org ${row.orgId}`);
			// The creator may still be inside Stripe; absence cannot prove no charge.
			if (!found) throw new Error(list.has_more ? 'Canceled auto top-up lookup needs manual reconciliation: payment list truncated' : 'Canceled auto top-up payment not found yet — retry or manual reconciliation required');
		} catch (error) {
			await db.update(stripeAutoTopupRecoveries).set({ lastError: 'refund_or_cancellation_failed' }).where(predicate);
			console.error(`auto top-up recovery sweep failed for org ${row.orgId}`, error);
		}
	}
	return rows.length;
}
