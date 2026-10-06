import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type Stripe from 'stripe';

import { db } from '$lib/server/db';
import { creditTransactions, organizations, stripeAutoTopupRecoveries } from '$lib/server/db/schema';
import { applyLedgerDelta, type LedgerHandle } from './ledger';
import { topupAttemptCorrelation, InvalidTopupPayment, type TopupPayment } from './topupCorrelation';
import { getStripe } from '$lib/server/stripe/client';
import { chargeFullyRefunded, refundUngrantablePayment } from '$lib/server/stripe/refunds';
import { CronDiagnostics, describeCronFailure } from '../../../../scripts/lib/cron-diagnostics.mjs';

export { topupAttemptCorrelation } from './topupCorrelation';
export type { TopupPayment } from './topupCorrelation';

type Recovery = typeof stripeAutoTopupRecoveries.$inferSelect;

/** Each request gets the remaining shared budget; retries would multiply it. */
function recoveryOptions(deadline?: number): [] | [Stripe.RequestOptions] {
	if (deadline === undefined) return [];
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error('Auto top-up recovery shared deadline expired');
	return [{ timeout: remaining, maxNetworkRetries: 0 }];
}

/** Prefer a bound PaymentIntent; never correlate a different payment to that row. */
export async function findPausedTopup(handle: LedgerHandle, orgId: string, pi: TopupPayment): Promise<Recovery | undefined> {
	const correlation = topupAttemptCorrelation(pi, stripeAutoTopupRecoveries.attemptAt);
	const known = await handle.select().from(stripeAutoTopupRecoveries).where(and(eq(stripeAutoTopupRecoveries.orgId, orgId), eq(stripeAutoTopupRecoveries.paymentIntentId, pi.id))).get();
	if (known) return known.lastError === 'payment_precedes_refund' && known.resolvedAt ? undefined : known;
	if (!correlation) {
		const pending = await handle.select({ id: stripeAutoTopupRecoveries.id }).from(stripeAutoTopupRecoveries).where(and(eq(stripeAutoTopupRecoveries.orgId, orgId), isNull(stripeAutoTopupRecoveries.resolvedAt))).get();
		if (pending) throw new Error(`auto top-up ${pi.id} cannot be correlated to a canceled attempt`);
		return undefined;
	}
	const rows = await handle.select().from(stripeAutoTopupRecoveries).where(and(eq(stripeAutoTopupRecoveries.orgId, orgId), isNull(stripeAutoTopupRecoveries.paymentIntentId), correlation)).limit(2).all();
	if (rows.length > 1) throw new Error(`auto top-up ${pi.id} matches multiple canceled attempts`);
	return rows[0];
}

/** Validate the latest charge's identity and integer amounts before confirming existing refunds. */
function recoveryCharge(charges: Stripe.ApiList<Stripe.Charge>, paymentIntentId: string) {
	const charge = charges.data?.[0];
	const paymentRef = charge?.payment_intent;
	const chargeIntent = typeof paymentRef === 'string' ? paymentRef : paymentRef && typeof paymentRef === 'object' ? paymentRef.id : undefined;
	if (!Array.isArray(charges.data) || charges.data.length !== 1 || !charge || typeof charge.id !== 'string' || !charge.id || chargeIntent !== paymentIntentId || !Number.isSafeInteger(charge.amount) || charge.amount <= 0 || !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 || charge.amount_refunded > charge.amount) throw new Error('Canceled auto top-up has an invalid charge');
	return charge;
}

/** Reject malformed refund records before using their amounts to confirm repayment. */
function validateExistingRefund(refund: Stripe.Refund) {
	if (!refund || typeof refund.id !== 'string' || !refund.id.trim() || !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || !['succeeded', 'pending', 'requires_action', 'failed', 'canceled'].includes(refund.status ?? '')) throw new Error('Stripe returned an invalid existing refund');
}

/** Existing full refunds resolve only after Stripe confirms the returned amount. */
async function existingRefundOutcome(paymentIntentId: string, deadline?: number): Promise<{ chargeId: string; created: number; resolved?: boolean }> {
	const charge = recoveryCharge(await getStripe().charges.list({ payment_intent: paymentIntentId, limit: 1 }, ...recoveryOptions(deadline)), paymentIntentId);
	if (!chargeFullyRefunded(charge)) return { chargeId: charge.id, created: charge.created };
	// ponytail: one refund page; over 100 refunds requires manual reconciliation.
	const refunds = await getStripe().refunds.list({ charge: charge.id, limit: 100 }, ...recoveryOptions(deadline));
	if (!Array.isArray(refunds.data) || refunds.has_more) throw new Error('Existing auto top-up refunds need manual reconciliation');
	let completed = 0;
	let pending = 0;
	for (const refund of refunds.data) {
		validateExistingRefund(refund);
		if (refund.status === 'succeeded') completed += refund.amount;
		if (refund.status === 'pending' || refund.status === 'requires_action') pending += refund.amount;
	}
	if (completed + pending !== charge.amount) throw new Error('Existing full refund could not be confirmed — manual reconciliation required');
	return { chargeId: charge.id, created: charge.created, resolved: completed === charge.amount };
}

async function paymentPrecedesRefund(row: Recovery, created: number): Promise<boolean> {
	if (!row.refundOccurredAt) return false;
	const org = await db.select({ consentedAt: organizations.autoTopupConsentedAt }).from(organizations).where(eq(organizations.id, row.orgId)).get();
	if (!org) return false;
	const refundAt = Date.parse(row.refundOccurredAt);
	const consentedAt = org.consentedAt === null ? Number.NaN : Date.parse(org.consentedAt);
	if (!Number.isSafeInteger(created) || created <= 0 || created * 1000 > Date.now() + 5 * 60_000 || !Number.isFinite(refundAt) || (org.consentedAt !== null && !Number.isFinite(consentedAt))) throw new InvalidTopupPayment('Recovery has an invalid payment or refund timestamp');
	// Consent granted after this refund authorizes only payments charged under it.
	return created * 1000 < refundAt || (consentedAt > refundAt && created * 1000 >= consentedAt);
}

/** Persist the refund identity until Stripe confirms its terminal outcome. */
async function cancelOrRefund(row: Recovery, pi: TopupPayment, deadline?: number): Promise<{ resolved: boolean; chargeId?: string; preserved?: boolean }> {
	if (pi.status === 'canceled') return { resolved: true };
	if (pi.status !== 'succeeded') {
		if (!['requires_payment_method', 'requires_capture', 'requires_confirmation', 'requires_action', 'processing'].includes(pi.status ?? '')) throw new InvalidTopupPayment('Canceled auto top-up has an invalid payment status');
		const canceled = await getStripe().paymentIntents.cancel(pi.id, { cancellation_reason: 'requested_by_customer' }, ...recoveryOptions(deadline));
		if (canceled.id !== pi.id || canceled.status !== 'canceled') throw new Error('Auto top-up cancellation did not complete');
		return { resolved: true };
	}
	const existing = await existingRefundOutcome(pi.id, deadline);
	if (await paymentPrecedesRefund(row, existing.created)) return { resolved: true, preserved: true };
	if (existing.resolved !== undefined) return { chargeId: existing.chargeId, resolved: existing.resolved };
	const refund = row.refundId
		? await getStripe().refunds.retrieve(row.refundId, undefined, ...recoveryOptions(deadline))
		: await refundUngrantablePayment({ requestOptions: recoveryOptions(deadline)[0], paymentIntentId: pi.id, orgId: row.orgId, idempotencyKey: `refund:autotopup-paused:${pi.id}`, label: `auto top-up ${pi.id} overlapped a refund pause` });
	if (typeof refund.id !== 'string' || !refund.id.trim() || !['succeeded', 'pending', 'requires_action'].includes(refund.status ?? '')) throw new Error('MANUAL REFUND REQUIRED: canceled auto top-up refund failed');
	await db.update(stripeAutoTopupRecoveries).set({ refundId: refund.id }).where(eq(stripeAutoTopupRecoveries.id, row.id));
	return { chargeId: existing.chargeId, resolved: refund.status === 'succeeded' };
}

/** Returns true when recovery is resolved. Never grants credits. */
export async function recoverPausedTopup(row: Recovery, pi: TopupPayment, deadline?: number): Promise<boolean> {
	if (pi.metadata?.type !== 'auto_topup' || pi.metadata.org_id !== row.orgId) throw new Error('Canceled auto top-up payment has invalid organization metadata');
	const predicate = eq(stripeAutoTopupRecoveries.id, row.id);
	const current = await db.select().from(stripeAutoTopupRecoveries).where(predicate).get();
	if (!current) throw new Error('Canceled auto top-up recovery was not found');
	if (current.paymentIntentId && current.paymentIntentId !== pi.id) throw new Error('Canceled auto top-up has a different payment intent');
	if (current.resolvedAt) return true;
	if (current.lastError === 'ambiguous_payment') throw new Error('Canceled auto top-up matches multiple payments — manual reconciliation required');
	const bound = await db.update(stripeAutoTopupRecoveries).set({ paymentIntentId: pi.id, paymentLookupCursor: null, lookupCandidateId: null, lastCheckedAt: new Date().toISOString() }).where(and(predicate, isNull(stripeAutoTopupRecoveries.resolvedAt), or(isNull(stripeAutoTopupRecoveries.lastError), ne(stripeAutoTopupRecoveries.lastError, 'ambiguous_payment')), or(isNull(stripeAutoTopupRecoveries.paymentIntentId), eq(stripeAutoTopupRecoveries.paymentIntentId, pi.id)))).returning({ id: stripeAutoTopupRecoveries.id });
	if (!bound.length) throw new Error('Canceled auto top-up was bound to another payment');
	try {
		const result = await cancelOrRefund(current, pi, deadline);
		await db.transaction(async (tx) => {
			if (result.resolved && result.chargeId) {
				const grant = await tx.select({ delta: creditTransactions.delta, chargeId: creditTransactions.chargeId }).from(creditTransactions)
					.where(and(eq(creditTransactions.orgId, row.orgId), eq(creditTransactions.paymentIntentId, pi.id), eq(creditTransactions.reason, 'auto_topup'))).get();
				if (grant) {
					if (grant.chargeId && grant.chargeId !== result.chargeId) throw new Error('Recovered refund charge does not match the granted payment');
					await applyLedgerDelta(tx, { orgId: row.orgId, delta: -grant.delta, reason: 'refund', refType: 'refund', refId: result.chargeId, chargeId: result.chargeId, paymentIntentId: pi.id, refundRecovery: true });
				}
			}
			const unchangedBoundary = current.refundOccurredAt ? eq(stripeAutoTopupRecoveries.refundOccurredAt, current.refundOccurredAt) : isNull(stripeAutoTopupRecoveries.refundOccurredAt);
			const recorded = await tx.update(stripeAutoTopupRecoveries).set({ lastError: result.preserved ? 'payment_precedes_refund' : null, ...(result.resolved ? { resolvedAt: new Date().toISOString() } : {}) }).where(result.preserved ? and(predicate, unchangedBoundary) : predicate).returning({ id: stripeAutoTopupRecoveries.id });
			if (!recorded.length) throw new Error('Refund boundary changed during recovery — retry required');
		});
		return result.resolved;
	} catch (error) {
		const failed = await db.update(stripeAutoTopupRecoveries).set({ lastError: 'refund_or_cancellation_failed' }).where(and(predicate, isNull(stripeAutoTopupRecoveries.resolvedAt))).returning({ id: stripeAutoTopupRecoveries.id });
		if (!failed.length && (await db.select().from(stripeAutoTopupRecoveries).where(predicate).get())?.resolvedAt) return true;
		console.error('auto top-up recovery failed — retry or manual refund required', JSON.stringify(describeCronFailure(error, 'paused auto top-up recovery')));
		throw error;
	}
}

async function matchingListedPayment(row: Recovery, pi: TopupPayment): Promise<boolean> {
	if (!pi || typeof pi.id !== 'string' || !pi.id || !['succeeded', 'canceled', 'requires_payment_method', 'requires_capture', 'requires_confirmation', 'requires_action', 'processing'].includes(pi.status ?? '')) throw new InvalidTopupPayment('Malformed payment intent');
	if (pi.metadata?.type !== 'auto_topup' || pi.metadata.org_id !== row.orgId) return false;
	if (!topupAttemptCorrelation(pi, stripeAutoTopupRecoveries.attemptAt)) throw new InvalidTopupPayment('Payment intent has no attempt correlation');
	return (await findPausedTopup(db, row.orgId, pi))?.id === row.id;
}

async function selectListedCandidate(row: Recovery, payments: TopupPayment[]) {
	let skipped = 0;
	let candidateId = row.lookupCandidateId;
	let candidate: TopupPayment | undefined;
	for (const pi of payments) {
		try {
			if (!(await matchingListedPayment(row, pi))) continue;
			if (candidateId && candidateId !== pi.id) {
				await db.update(stripeAutoTopupRecoveries).set({ lastError: 'ambiguous_payment' }).where(eq(stripeAutoTopupRecoveries.id, row.id));
				throw new Error('Canceled auto top-up matches multiple payments — manual reconciliation required');
			}
			candidateId = pi.id;
			candidate = pi;
		} catch (error) {
			if (!(error instanceof InvalidTopupPayment)) throw error;
			skipped++;
		}
	}
	if (skipped) console.error('auto top-up recovery skipped malformed payment items', { skipped });
	return { candidateId, candidate };
}

async function listRecoveryPayments(row: Recovery, deadline?: number) {
	const customerId = row.customerId ?? (await db.select({ customerId: organizations.stripeCustomerId }).from(organizations).where(eq(organizations.id, row.orgId)).get())?.customerId;
	if (!customerId) throw new Error('Canceled auto top-up organization has no Stripe customer');
	const attemptMs = Date.parse(row.attemptAt);
	if (!Number.isFinite(attemptMs)) throw new Error('Canceled auto top-up has an invalid attempt timestamp');
	const list = await getStripe().paymentIntents.list({ customer: customerId, created: { gte: Math.floor((attemptMs - 60_000) / 1000) }, limit: 100, ...(row.paymentLookupCursor ? { starting_after: row.paymentLookupCursor } : {}) }, ...recoveryOptions(deadline));
	if (!list || !Array.isArray(list.data) || typeof list.has_more !== 'boolean') throw new Error('Stripe returned an invalid payment intent list');
	return list;
}

/** Scan one page per tick, choosing only after the entire result is unambiguous. */
async function recoverListedPayment(row: Recovery, deadline?: number): Promise<void> {
	if (row.lastError === 'ambiguous_payment') throw new Error('Canceled auto top-up matches multiple payments — manual reconciliation required');
	const list = await listRecoveryPayments(row, deadline);
	const progressPredicate = and(eq(stripeAutoTopupRecoveries.id, row.id), isNull(stripeAutoTopupRecoveries.resolvedAt), isNull(stripeAutoTopupRecoveries.paymentIntentId), or(isNull(stripeAutoTopupRecoveries.lastError), ne(stripeAutoTopupRecoveries.lastError, 'ambiguous_payment')), row.paymentLookupCursor ? eq(stripeAutoTopupRecoveries.paymentLookupCursor, row.paymentLookupCursor) : isNull(stripeAutoTopupRecoveries.paymentLookupCursor));
	const { candidateId, candidate } = await selectListedCandidate(row, list.data);
	if (list.has_more) {
		const cursor = list.data.at(-1)?.id;
		if (typeof cursor !== 'string' || !cursor || cursor === row.paymentLookupCursor) throw new Error('Stripe returned an invalid recovery pagination cursor');
		await db.update(stripeAutoTopupRecoveries).set({ paymentLookupCursor: cursor, lookupCandidateId: candidateId, lastError: null }).where(progressPredicate);
		return;
	}
	if (!candidateId) {
		await db.update(stripeAutoTopupRecoveries).set({ paymentLookupCursor: null, lookupCandidateId: null }).where(progressPredicate);
		throw new Error('Canceled auto top-up payment not found yet — retry or manual reconciliation required');
	}
	const payment = candidate ?? await getStripe().paymentIntents.retrieve(candidateId, undefined, ...recoveryOptions(deadline));
	if (payment.id !== candidateId || (await findPausedTopup(db, row.orgId, payment))?.id !== row.id) throw new InvalidTopupPayment('Recovered payment does not match the selected attempt');
	await recoverPausedTopup(row, payment, deadline);
}

/** Count attempted work (including failures), excluding rows skipped at the deadline. */
export async function sweepPausedTopups(limit: number, deadline?: number, diagnostics = new CronDiagnostics()): Promise<number> {
	const rows = await db.select().from(stripeAutoTopupRecoveries).where(and(isNull(stripeAutoTopupRecoveries.resolvedAt), or(isNull(stripeAutoTopupRecoveries.lastError), ne(stripeAutoTopupRecoveries.lastError, 'ambiguous_payment')))).orderBy(asc(stripeAutoTopupRecoveries.lastCheckedAt), asc(stripeAutoTopupRecoveries.id)).limit(limit).all();
	let attempted = 0;
	for (const row of rows) {
		if (deadline !== undefined && Date.now() >= deadline) break;
		attempted++;
		const predicate = and(eq(stripeAutoTopupRecoveries.id, row.id), isNull(stripeAutoTopupRecoveries.resolvedAt));
		await db.update(stripeAutoTopupRecoveries).set({ lastCheckedAt: new Date().toISOString() }).where(predicate);
		try {
			if (row.paymentIntentId) await recoverPausedTopup(row, await getStripe().paymentIntents.retrieve(row.paymentIntentId, undefined, ...recoveryOptions(deadline)), deadline);
			else await recoverListedPayment(row, deadline);
		} catch (error) {
			await db.update(stripeAutoTopupRecoveries).set({ lastError: sql`CASE WHEN ${stripeAutoTopupRecoveries.lastError} = 'ambiguous_payment' THEN ${stripeAutoTopupRecoveries.lastError} ELSE 'refund_or_cancellation_failed' END` }).where(predicate);
			diagnostics.report('paused auto top-up recovery', error);
		}
	}
	return attempted;
}
