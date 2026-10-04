// Capped automatic enrollment, optional operator backfill and count-only monitoring. Never calls SMTP.
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { db, withBusyRetry } from './db';
import { users, welcomeDiscovery, welcomeEmails } from './db/schema';
import { welcomeFailureCategory } from './welcomeDiagnostics';
import { WELCOME_CAMPAIGN, enqueueWelcome, exclusion, isHistoricalCandidate, isOfficialHosted, sendingEnabled, type Account, type WelcomeRow } from './welcomeEnrollment';
const MAX_BACKFILL_BATCH = 25;
const DISCOVERY_LEASE_MS = 60_000;

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

async function claimDiscovery() {
	return withBusyRetry(() => db.transaction(async tx => {
		const now = new Date(Date.now()).toISOString();
		const claimToken = randomBytes(24).toString('hex');
		await tx.insert(welcomeDiscovery).values({ campaign: WELCOME_CAMPAIGN }).onConflictDoNothing();
		const [claimed] = await tx.update(welcomeDiscovery).set({ claimToken,
			leaseExpiresAt: new Date(Date.now() + DISCOVERY_LEASE_MS).toISOString() })
			.where(and(eq(welcomeDiscovery.campaign, WELCOME_CAMPAIGN),
				or(isNull(welcomeDiscovery.leaseExpiresAt), lte(welcomeDiscovery.leaseExpiresAt, now)))).returning();
		if (!claimed) return undefined;
		if (claimed.cycleEndUserId !== null) return { ...claimed, claimToken };
		// The maximum is an indexed one-row lookup. Keep this upper bound for
		// the entire traversal so new high ids cannot postpone wrap forever.
		const last = await tx.select({ id: users.id }).from(users).orderBy(desc(users.id)).limit(1).get();
		const cycleEndUserId = last?.id ?? null;
		await tx.update(welcomeDiscovery).set({ afterUserId: null, cycleEndUserId })
			.where(eq(welcomeDiscovery.campaign, WELCOME_CAMPAIGN));
		return { ...claimed, afterUserId: null, cycleEndUserId, claimToken };
	}));
}

type DiscoveryClaim = NonNullable<Awaited<ReturnType<typeof claimDiscovery>>>;
function discoveryOwner(claim: DiscoveryClaim) {
	return and(eq(welcomeDiscovery.campaign, WELCOME_CAMPAIGN), eq(welcomeDiscovery.claimToken, claim.claimToken));
}
async function advanceDiscovery(handle: Pick<typeof db, 'update'>, claim: DiscoveryClaim, userId: string) {
	const advanced = await handle.update(welcomeDiscovery).set({ afterUserId: userId })
		.where(and(discoveryOwner(claim), gt(welcomeDiscovery.leaseExpiresAt, new Date(Date.now()).toISOString())))
		.returning({ campaign: welcomeDiscovery.campaign });
	return advanced.length === 1;
}

/** One unfiltered keyset page per tick; failed accounts return after a finite traversal. */
export async function enrollWelcomeCandidates(deadline: number) {
	const counts = { scanned: 0, queued: 0, enrollmentErrors: 0 };
	if (!sendingEnabled() || Date.now() >= deadline) return counts;
	const claim = await claimDiscovery();
	if (!claim) return counts;
	let completed = false;
	try {
		if (Date.now() >= deadline) return counts;
		// Resolve only ids here. Eligibility reads and writes happen afterwards
		// on these <=25 ids, so LIMIT bounds examined users, even if all are sent.
		const page = claim.cycleEndUserId === null ? [] : await db.select({ id: users.id }).from(users)
			.where(and(claim.afterUserId === null ? undefined : gt(users.id, claim.afterUserId), lte(users.id, claim.cycleEndUserId)))
			.orderBy(asc(users.id)).limit(MAX_BACKFILL_BATCH);
		for (const account of page) {
			if (Date.now() >= deadline) break;
			try {
				const queued = await withBusyRetry(() => db.transaction(async tx => {
					// Advancing and enrolling commit together. A stale lease owner
					// cannot enroll a page or overwrite a successor's checkpoint.
					if (!await advanceDiscovery(tx, claim, account.id)) return undefined;
					const welcome = await tx.select().from(welcomeEmails)
						.where(and(eq(welcomeEmails.userId, account.id), eq(welcomeEmails.campaign, WELCOME_CAMPAIGN))).get();
					if (!isHistoricalCandidate(welcome) || welcome?.suppressionReason ||
						(welcome?.cohort && welcome.cohort !== 'official-hosted')) return false;
					return enqueueWelcome(tx, account.id, welcome?.state === 'never_sent' ? 'never_sent' : 'historical_unknown');
				}));
				if (queued === undefined) break;
				counts.scanned++;
				if (queued) counts.queued++;
			} catch (cause) {
				counts.enrollmentErrors++;
				console.error('[welcome] account enrollment failed; continuing candidate page', { category: welcomeFailureCategory(cause) });
				// Enrollment rolled back its checkpoint. Persist the failed id
				// separately so repeated failures cannot pin other users behind it.
				if (!await withBusyRetry(() => advanceDiscovery(db, claim, account.id))) break;
				counts.scanned++;
			}
		}
		completed = counts.scanned === page.length && (page.length < MAX_BACKFILL_BATCH || page.at(-1)?.id === claim.cycleEndUserId);
		return counts;
	} finally {
		// Only inspected ids advance; a spent deadline resumes unprocessed ids.
		// Empty/deleted tails also wrap. The token protects against late cleanup
		// from an expired worker after another invocation acquired the lease.
		await withBusyRetry(() => db.update(welcomeDiscovery).set({ claimToken: null, leaseExpiresAt: null,
			...(completed ? { afterUserId: null, cycleEndUserId: null } : {}) }).where(discoveryOwner(claim)));
	}
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
