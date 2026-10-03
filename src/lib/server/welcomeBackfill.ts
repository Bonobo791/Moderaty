// Human-operated, bounded backfill and count-only monitoring. Never calls SMTP.
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { db, withBusyRetry } from './db';
import { users, welcomeEmails } from './db/schema';
import { WELCOME_CAMPAIGN, enqueueWelcome, exclusion, isOfficialHosted, type Account, type WelcomeRow } from './welcomeEnrollment';
const MAX_BACKFILL_BATCH = 25;

function backfillEligible(account: Account, row?: WelcomeRow): boolean {
	return !exclusion(account, row) && !row?.acceptedAt && (!row || ['historical_unknown', 'never_sent'].includes(row.state));
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
/** Bounded/resumable enrollment only; operator reviews preview and chooses each batch. */
export async function backfillWelcomeBatch(options: { afterUserId?: string | null; limit: number }) {
	if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_BACKFILL_BATCH) throw new Error('Welcome backfill limit must be 1–25');
	if (!isOfficialHosted()) throw new Error('Welcome backfill requires official-hosted deployment');
	const page = await backfillPage(options.afterUserId ?? null, options.limit);
	let queued = 0;
	for (const { account, welcome } of page) {
		if (backfillEligible(account, welcome ?? undefined)) {
			// Serialize the fresh eligibility read/write with account teardown.
			// The page snapshot above can be stale by the time this batch runs.
			const enrolled = await withBusyRetry(() => db.transaction(tx =>
				enqueueWelcome(tx, account.id, welcome?.state === 'never_sent' ? 'never_sent' : 'historical_unknown')));
			if (enrolled) queued++;
		}
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
