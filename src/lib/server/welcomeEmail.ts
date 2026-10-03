// First service welcome only. Historical unknown (authorized backfill) and an
// ambiguous NEW SMTP attempt are deliberately different states.
import { randomBytes } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, withBusyRetry } from './db';
import { channels, memberships, users, welcomeEmails } from './db/schema';
import { isBareAddress, ProtonMailConfigurationError, ProtonMailPreSubmissionDeadlineError, ProtonMailSubmissionError, sendProtonMailEmail } from './protonMail';
import { buildWelcomeEmail, welcomeAppOrigin, WELCOME_TEMPLATE_VERSION, type WelcomeTeam } from './welcomeEmailTemplate';

export const WELCOME_CAMPAIGN = 'hosted-signup-welcome';
const COHORT = 'official-hosted';
const LEASE_MS = 60_000; // exceeds Proton's hard 10s operation limit
const MAX_ATTEMPTS = 5;
const MAX_BACKFILL_BATCH = 25;
const THROTTLE_MS = 60_000; // global campaign cap, including overlapping cron ticks
const key = (userId: string) => and(eq(welcomeEmails.userId, userId), eq(welcomeEmails.campaign, WELCOME_CAMPAIGN));
type Handle = Pick<typeof db, 'select' | 'insert' | 'update'>;
type WelcomeRow = typeof welcomeEmails.$inferSelect;
type Account = Pick<typeof users.$inferSelect, 'id' | 'email' | 'googleSub' | 'displayName'>;

/** Deliberate deployment declaration; free/unsubscribed users are included. */
export function isOfficialHosted(): boolean {
	const value = env.MODERATY_DEPLOYMENT;
	if (value && value !== COHORT && value !== 'self-hosted') throw new Error('MODERATY_DEPLOYMENT must be official-hosted or self-hosted');
	return value === COHORT;
}
function sendingEnabled(): boolean {
	if (env.WELCOME_EMAIL_ENABLED && !['true', 'false'].includes(env.WELCOME_EMAIL_ENABLED)) throw new Error('WELCOME_EMAIL_ENABLED must be true or false');
	return isOfficialHosted() && env.WELCOME_EMAIL_ENABLED === 'true' && env.DRY_RUN === 'false';
}

/** Same recipient policy at enrollment, preview/backfill, and immediately before SMTP. */
function exclusion(account: Account | undefined, row?: WelcomeRow): string | null {
	if (!account || account.googleSub.startsWith('deleted:') || account.email === '[deleted]') return 'deleted_account';
	if (row?.suppressionReason || row?.state === 'suppressed') return 'operational_suppression';
	if (row?.cohort && row.cohort !== COHORT) return 'non_hosted_cohort';
	const domain = account.email.split('@')[1]?.toLowerCase();
	if (!isBareAddress(account.email) || !domain || domain === 'accounts.google.com' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain) || domain.includes('..')) return 'invalid_recipient';
	return null;
}

/** Call inside signup's transaction ONLY for a newly inserted user. Never sends mail. */
export async function enqueueWelcome(handle: Handle, userId: string, source: 'signup' | 'historical_unknown' | 'never_sent'): Promise<boolean> {
	if (!isOfficialHosted()) return false;
	const account = await handle.select().from(users).where(eq(users.id, userId)).get();
	// Tombstoned users retain their FK identity for legal evidence only.
	// Never recreate erased delivery metadata, including a suppressed row.
	if (!account || account.googleSub.startsWith('deleted:') || account.email === '[deleted]') return false;
	const existing = await handle.select().from(welcomeEmails).where(key(userId)).get();
	if (existing?.acceptedAt || (existing && !['historical_unknown', 'never_sent'].includes(existing.state))) return false;
	const reason = exclusion(account, existing);
	const now = new Date().toISOString();
	const values = { userId, campaign: WELCOME_CAMPAIGN, templateVersion: WELCOME_TEMPLATE_VERSION,
		state: reason ? 'suppressed' : 'queued', cohort: COHORT, source: existing?.source ?? source,
		messageId: existing?.messageId ?? `<moderaty-welcome-${randomBytes(24).toString('hex')}@moderaty.com>`,
		queuedAt: reason ? null : now, nextRetryAt: reason ? null : now, suppressionReason: reason };
	if (!existing) {
		const inserted = await handle.insert(welcomeEmails).values(values).onConflictDoNothing().returning({ userId: welcomeEmails.userId });
		return inserted.length === 1 && !reason;
	}
	const updated = await handle.update(welcomeEmails).set(values).where(and(key(userId), inArray(welcomeEmails.state, ['historical_unknown', 'never_sent']), isNull(welcomeEmails.acceptedAt), isNull(welcomeEmails.suppressionReason))).returning({ userId: welcomeEmails.userId });
	return updated.length === 1 && !reason;
}

async function contentTeams(userId: string): Promise<WelcomeTeam[]> {
	const rows = await db.select({ role: memberships.role, channelId: channels.id, active: channels.active, used: channels.moderationDryRunUsedAt })
		.from(memberships).leftJoin(channels, eq(channels.orgId, memberships.orgId)).where(eq(memberships.userId, userId));
	return rows.map(row => {
		if (!['owner', 'admin', 'member'].includes(row.role)) throw new Error('Unknown welcome membership role');
		return { role: row.role as WelcomeTeam['role'], channels: row.channelId ? [{ active: row.active === 1, previewUsed: row.used !== null }] : [] };
	});
}

export type WelcomeDelivery = 'accepted' | 'deferred' | 'suppressed' | 'failed' | 'ambiguous';
/** Fenced claim + fresh eligibility, followed by one bounded SMTP attempt. */
export async function deliverWelcome(userId: string, deadline: number): Promise<WelcomeDelivery> {
	if (!sendingEnabled() || Date.now() >= deadline) return 'deferred';
	const appUrl = welcomeAppOrigin(env.APP_URL ?? ''); // fail before claim/network
	const now = new Date().toISOString();
	const claimToken = randomBytes(16).toString('hex');
	const [claimed] = await db.update(welcomeEmails).set({ state: 'claimed', claimToken, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() })
		.where(and(key(userId), inArray(welcomeEmails.state, ['queued', 'retryable_failure']), isNull(welcomeEmails.acceptedAt), isNull(welcomeEmails.suppressionReason), lte(welcomeEmails.nextRetryAt, now),
			// One global rate-limited campaign slot, atomically checked with the claim.
			sql`NOT EXISTS (SELECT 1 FROM welcome_emails AS busy WHERE busy.campaign = ${WELCOME_CAMPAIGN} AND ((busy.state IN ('claimed', 'in_flight') AND busy.lease_expires_at > ${now}) OR busy.last_attempt_at > ${new Date(Date.now() - THROTTLE_MS).toISOString()}))`
		)).returning();
	if (!claimed) return 'deferred';
	const owned = and(key(userId), eq(welcomeEmails.claimToken, claimToken));
	// A failure before the durable in_flight boundary leaves a claim which
	// can safely recover on expiry. No SMTP has been invoked at that point.
	const teams = await contentTeams(userId);
	const account = await db.select().from(users).where(eq(users.id, userId)).get();
	const fresh = await db.select().from(welcomeEmails).where(owned).get();
	if (!fresh || fresh.state !== 'claimed') return 'deferred';
	const reason = exclusion(account, fresh);
	if (reason) {
		await db.update(welcomeEmails).set({ state: 'suppressed', suppressionReason: reason, nextRetryAt: null, claimToken: null, leaseExpiresAt: null }).where(owned);
		return 'suppressed';
	}
	if (!sendingEnabled() || Date.now() >= deadline) {
		await db.update(welcomeEmails).set({ state: 'queued', claimToken: null, leaseExpiresAt: null }).where(owned);
		return 'deferred';
	}
	const message = buildWelcomeEmail({ email: account!.email, displayName: account!.displayName, messageId: fresh.messageId, appUrl, teams });
	const started = await db.update(welcomeEmails).set({ state: 'in_flight', attempts: fresh.attempts + 1, lastAttemptAt: new Date().toISOString(), lastError: null })
		.where(and(owned, eq(welcomeEmails.state, 'claimed'), isNull(welcomeEmails.suppressionReason), isNull(welcomeEmails.acceptedAt),
			sql`EXISTS (SELECT 1 FROM users WHERE users.id = ${userId} AND users.email = ${account!.email} AND users.google_sub = ${account!.googleSub})`)).returning({ userId: welcomeEmails.userId });
	if (!started.length) return 'deferred';
	let result;
	try { result = await sendProtonMailEmail(message, deadline); }
	catch (cause) {
		if (cause instanceof ProtonMailPreSubmissionDeadlineError) {
			// The transport proves sendMail was never invoked. Release the slot
			// without spending a send attempt or leaving false SMTP uncertainty.
			await db.update(welcomeEmails).set({ state: 'queued', attempts: fresh.attempts,
				lastAttemptAt: fresh.lastAttemptAt, lastError: cause.category,
				nextRetryAt: new Date(Date.now() + 60_000).toISOString(), claimToken: null, leaseExpiresAt: null })
				.where(and(owned, eq(welcomeEmails.state, 'in_flight')));
			return 'deferred';
		}
		const classified = cause instanceof ProtonMailSubmissionError;
		const outcome = cause instanceof ProtonMailConfigurationError ? 'retryable' : classified ? cause.outcome : 'unknown';
		const exhausted = fresh.attempts + 1 >= MAX_ATTEMPTS;
		const state = outcome === 'unknown' ? 'ambiguous' : outcome === 'permanent' || exhausted ? 'permanent_failure' : 'retryable_failure';
		const category = exhausted && outcome === 'retryable' ? 'retry_exhausted' : cause instanceof ProtonMailConfigurationError ? 'configuration' : classified ? cause.category : 'unconfirmed_submission';
		await db.update(welcomeEmails).set({ state, lastError: category, nextRetryAt: state === 'retryable_failure' ? new Date(Date.now() + Math.min(60_000 * 2 ** fresh.attempts, 3_600_000)).toISOString() : null, claimToken: null, leaseExpiresAt: null }).where(and(owned, eq(welcomeEmails.state, 'in_flight')));
		console.error('[welcome] submission not accepted', { category, state });
		return state === 'ambiguous' ? 'ambiguous' : 'failed';
	}
	// Do NOT put this write in the send catch: acceptance followed by a DB
	// error is ambiguous, never a retryable send failure. Its lease expires
	// to manual review after restart. Stable Message-ID is not deduplication.
	const accepted = await db.update(welcomeEmails).set({ state: 'accepted', acceptedAt: new Date().toISOString(), providerMessageId: result.messageId, nextRetryAt: null, claimToken: null, leaseExpiresAt: null })
		.where(and(owned, eq(welcomeEmails.state, 'in_flight'))).returning({ userId: welcomeEmails.userId });
	if (accepted.length !== 1) throw new Error('Welcome acceptance could not be persisted; reconcile before retry');
	return 'accepted';
}

/** Existing authenticated cron calls this. At most one send and 25 crash recoveries. */
export async function sweepWelcomeEmails(deadline: number) {
	const counts = { accepted: 0, errors: 0, ambiguous: 0, suppressed: 0 };
	if (!sendingEnabled() || Date.now() >= deadline) return counts;
	counts.ambiguous = (await welcomeQueueStatus()).ambiguous ?? 0;
	const expired = await db.select().from(welcomeEmails).where(and(eq(welcomeEmails.campaign, WELCOME_CAMPAIGN), inArray(welcomeEmails.state, ['claimed', 'in_flight']), lte(welcomeEmails.leaseExpiresAt, new Date().toISOString()))).limit(25);
	for (const row of expired) {
		if (Date.now() >= deadline) return counts;
		const uncertain = row.state === 'in_flight';
		const updated = await db.update(welcomeEmails).set({ state: uncertain ? 'ambiguous' : 'queued', lastError: uncertain ? 'abandoned_submission' : 'abandoned_claim', nextRetryAt: uncertain ? null : new Date().toISOString(), claimToken: null, leaseExpiresAt: null })
			.where(and(key(row.userId), eq(welcomeEmails.state, row.state), eq(welcomeEmails.claimToken, row.claimToken!), eq(welcomeEmails.leaseExpiresAt, row.leaseExpiresAt!))).returning({ userId: welcomeEmails.userId });
		if (uncertain && updated.length) { counts.ambiguous++; console.error('[welcome] abandoned submission requires reconciliation'); }
	}
	const next = await db.select({ userId: welcomeEmails.userId }).from(welcomeEmails).where(and(eq(welcomeEmails.campaign, WELCOME_CAMPAIGN), inArray(welcomeEmails.state, ['queued', 'retryable_failure']), isNull(welcomeEmails.acceptedAt), isNull(welcomeEmails.suppressionReason), lte(welcomeEmails.nextRetryAt, new Date().toISOString()))).orderBy(asc(welcomeEmails.nextRetryAt), asc(welcomeEmails.userId)).limit(1).get();
	if (!next || Date.now() >= deadline) return counts;
	try {
		const outcome = await deliverWelcome(next.userId, deadline);
		if (outcome === 'accepted') counts.accepted++;
		if (outcome === 'ambiguous') counts.ambiguous++;
		if (outcome === 'suppressed') counts.suppressed++;
		if (outcome === 'failed') counts.errors++;
	} catch { counts.errors++; console.error('[welcome] queue processing failed; inspect durable state before retry'); }
	return counts;
}

function backfillEligible(account: Account, row?: WelcomeRow): boolean {
	return !exclusion(account, row) && !row?.acceptedAt && (!row || ['historical_unknown', 'never_sent'].includes(row.state));
}
async function backfillPage(afterUserId: string | null, limit: number) {
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
