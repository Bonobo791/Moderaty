// Bounded automatic discovery, optional operator backfill and count-only monitoring. Never calls SMTP.
import { and, asc, eq, gt, inArray, isNull, ne, notLike, or, sql } from 'drizzle-orm';
import { db, withBusyRetry } from './db';
import { users, welcomeEmails } from './db/schema';
import { welcomeFailureCategory } from './welcomeDiagnostics';
import { WELCOME_CAMPAIGN, enqueueWelcome, exclusion, isHistoricalCandidate, isOfficialHosted, sendingEnabled, type Account, type WelcomeRow } from './welcomeEnrollment';
const MAX_BACKFILL_BATCH = 25;

function backfillEligible(account: Account, row?: WelcomeRow): boolean {
	return !exclusion(account, row) && isHistoricalCandidate(row);
}
function backfillPage(afterUserId: string | null, limit: number) {
	return db.select({ account: users, welcome: welcomeEmails }).from(users)
		.leftJoin(welcomeEmails, and(eq(welcomeEmails.userId, users.id), eq(welcomeEmails.campaign, WELCOME_CAMPAIGN)))
		.where(afterUserId ? gt(users.id, afterUserId) : undefined).orderBy(asc(users.id)).limit(limit);
}
/** Read-only, count-only output. Historical unknown is eligible by explicit product decision. */
export async function previewWelcomeBackfill() {
	if (!isOfficialHosted()) throw new Error('Welcome backfill requires official-hosted deployment');
	const counts = { total: 0, eligible: 0, excluded: 0, historicalUnknown: 0 };
	let cursor: string | null = null;
	for (;;) {
		const page = await backfillPage(cursor, 250);
		for (const { account, welcome } of page) {
			counts.total++;
			if (backfillEligible(account, welcome ?? undefined)) {
				counts.eligible++;
				if (!welcome || welcome.state === 'historical_unknown') counts.historicalUnknown++;
			} else counts.excluded++;
		}
		if (page.length < 250) return counts;
		cursor = page[page.length - 1].account.id;
	}
}
function validateBackfillBatch(limit: number): void {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BACKFILL_BATCH) throw new Error('Welcome backfill limit must be 1–25');
	if (!isOfficialHosted()) throw new Error('Welcome backfill requires official-hosted deployment');
}

async function enrollHistoricalAccount(account: Account, welcome: WelcomeRow | null): Promise<boolean> {
	// Serialize the fresh eligibility read/write with account teardown.
	return withBusyRetry(() => db.transaction(tx =>
		enqueueWelcome(tx, account.id, welcome?.state === 'never_sent' ? 'never_sent' : 'historical_unknown')));
}

/**
 * Committed campaign rows are the resume record: only unenrolled candidates
 * enter the page. No in-memory cursor can lose progress or miss a later signup
 * that sorts before a previous page. Invalid recipients acquire suppression
 * records; deleted/terminal/excluded rows never pin the bounded candidate page.
 */
export async function enrollWelcomeCandidates(deadline: number) {
	const counts = { scanned: 0, queued: 0, enrollmentErrors: 0 };
	if (!sendingEnabled() || Date.now() >= deadline) return counts;
	const page = await db.select({ account: users, welcome: welcomeEmails }).from(users)
		.leftJoin(welcomeEmails, and(eq(welcomeEmails.userId, users.id), eq(welcomeEmails.campaign, WELCOME_CAMPAIGN)))
		.where(and(notLike(users.googleSub, 'deleted:%'), ne(users.email, '[deleted]'),
			or(isNull(welcomeEmails.userId), and(inArray(welcomeEmails.state, ['historical_unknown', 'never_sent']),
				isNull(welcomeEmails.acceptedAt), isNull(welcomeEmails.suppressionReason),
				or(isNull(welcomeEmails.cohort), eq(welcomeEmails.cohort, ''), eq(welcomeEmails.cohort, 'official-hosted'))))))
		.orderBy(asc(users.id)).limit(MAX_BACKFILL_BATCH);
	for (const { account, welcome } of page) {
		if (Date.now() >= deadline) break;
		counts.scanned++;
		try {
			if (await enrollHistoricalAccount(account, welcome)) counts.queued++;
		} catch (cause) {
			counts.enrollmentErrors++;
			console.error('[welcome] account enrollment failed; continuing candidate page', { category: welcomeFailureCategory(cause) });
		}
	}
	return counts;
}

/** Bounded/resumable enrollment only; operator reviews preview and chooses each batch. */
export async function backfillWelcomeBatch(options: { afterUserId?: string | null; limit: number }) {
	validateBackfillBatch(options.limit);
	const page = await backfillPage(options.afterUserId ?? null, options.limit);
	let queued = 0;
	for (const { account, welcome } of page) {
		// Deliberately sequential SQLite writers; the next record starts only
		// after the previous short transaction commits or exhausts busy retry.
		if (backfillEligible(account, welcome ?? undefined) && await enrollHistoricalAccount(account, welcome)) queued++;
	}
	return { scanned: page.length, queued, nextCursor: page.length === options.limit ? page[page.length - 1].account.id : null };
}

/** Operator monitoring contains state counts only, never addresses or message bodies. */
export async function welcomeQueueStatus(): Promise<Record<string, number>> {
	if (!isOfficialHosted()) throw new Error('Welcome status requires official-hosted deployment');
	const rows = await db.select({ state: welcomeEmails.state, count: sql<number>`count(*)` }).from(welcomeEmails)
		.where(eq(welcomeEmails.campaign, WELCOME_CAMPAIGN)).groupBy(welcomeEmails.state);
	return Object.fromEntries(rows.map(row => [row.state, Number(row.count)]));
}
