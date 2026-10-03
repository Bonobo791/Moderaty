// First service welcome only. Historical unknown is not a new ambiguous send.
import { randomBytes } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, withBusyRetry } from './db';
import { channels, memberships, users, welcomeCampaigns, welcomeEmails } from './db/schema';
import { sendProtonMailEmail, type ProtonMailMessage } from './protonMail';
import { buildWelcomeEmail, welcomeAppOrigin, type WelcomeTeam } from './welcomeEmailTemplate';
import { WELCOME_CAMPAIGN, exclusion, key, sendingEnabled, type WelcomeRow, type Account } from './welcomeEnrollment';
import { recordWelcomeAcceptance, recordWelcomeFailure, type WelcomeDelivery } from './welcomeDeliveryOutcome';
import { WelcomePreparationError, welcomeFailureCategory } from './welcomeDiagnostics';
import { enrollWelcomeCandidates } from './welcomeBackfill';
export { WELCOME_CAMPAIGN, enqueueWelcome, isOfficialHosted } from './welcomeEnrollment';
export { previewWelcomeBackfill, backfillWelcomeBatch, welcomeQueueStatus } from './welcomeBackfill';
export type { WelcomeDelivery } from './welcomeDeliveryOutcome';

const LEASE_MS = 60_000; // exceeds Proton's hard 10s operation limit
const THROTTLE_MS = 60_000;
const DIAGNOSTIC = {
	abandoned: '[welcome] abandoned submission requires reconciliation',
	processing: '[welcome] queue processing failed; inspect durable state before retry'
};
const due = (now: string) => and(eq(welcomeEmails.campaign, WELCOME_CAMPAIGN),
	inArray(welcomeEmails.state, ['queued', 'retryable_failure']), isNull(welcomeEmails.acceptedAt),
	isNull(welcomeEmails.suppressionReason), lte(welcomeEmails.nextRetryAt, now));

async function claimWelcome(userId: string) {
	return withBusyRetry(() => db.transaction(async tx => {
		const now = new Date().toISOString();
		const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
		const claimToken = randomBytes(16).toString('hex');
		await tx.insert(welcomeCampaigns).values({ campaign: WELCOME_CAMPAIGN, nextAttemptAt: now }).onConflictDoNothing();
		const [claimed] = await tx.update(welcomeEmails).set({ state: 'claimed', claimToken, leaseExpiresAt })
			.where(and(key(userId), due(now), sql`EXISTS (SELECT 1 FROM welcome_campaigns
				WHERE campaign = ${WELCOME_CAMPAIGN} AND next_attempt_at <= ${now})`)).returning();
		if (claimed) await tx.update(welcomeCampaigns).set({ nextAttemptAt: leaseExpiresAt }).where(eq(welcomeCampaigns.campaign, WELCOME_CAMPAIGN));
		return claimed;
	}));
}

async function contentTeams(userId: string): Promise<WelcomeTeam[]> {
	const rows = await db.select({ role: memberships.role, channelId: channels.id, active: channels.active, used: channels.moderationDryRunUsedAt })
		.from(memberships).leftJoin(channels, eq(channels.orgId, memberships.orgId)).where(eq(memberships.userId, userId));
	return rows.map(row => {
		if (!['owner', 'admin', 'member'].includes(row.role)) throw new WelcomePreparationError('invalid_membership');
		return { role: row.role as WelcomeTeam['role'], channels: row.channelId ? [{ active: row.active === 1, previewUsed: row.used !== null }] : [] };
	});
}

type Submission = { owned: SQL | undefined; fresh: WelcomeRow; message: ProtonMailMessage };
type Preparation = Submission | { outcome: WelcomeDelivery };

async function startSubmission(owned: SQL | undefined, account: Account, fresh: WelcomeRow): Promise<boolean> {
	return withBusyRetry(() => db.transaction(async tx => {
		const now = new Date().toISOString();
		const started = await tx.update(welcomeEmails).set({ state: 'in_flight', attempts: fresh.attempts + 1, lastAttemptAt: now, lastError: null })
			.where(and(owned, eq(welcomeEmails.state, 'claimed'), gt(welcomeEmails.leaseExpiresAt, now), isNull(welcomeEmails.suppressionReason), isNull(welcomeEmails.acceptedAt),
				sql`EXISTS (SELECT 1 FROM users WHERE users.id = ${account.id} AND users.email = ${account.email} AND users.google_sub = ${account.googleSub})`))
			.returning({ userId: welcomeEmails.userId });
		if (started.length !== 1) return false;
		await tx.update(welcomeCampaigns).set({ nextAttemptAt: new Date(Date.now() + THROTTLE_MS).toISOString() }).where(eq(welcomeCampaigns.campaign, WELCOME_CAMPAIGN));
		return true;
	}));
}

async function deferPreparation(owned: SQL | undefined): Promise<Preparation> {
	await db.update(welcomeEmails).set({ state: 'queued', claimToken: null, leaseExpiresAt: null }).where(owned);
	return { outcome: 'deferred' };
}

/** Refresh advisory context at the send boundary; a corrupt role cannot poison the queue. */
async function buildClaimedMessage(owned: SQL | undefined, account: Account, fresh: WelcomeRow, appUrl: string): Promise<ProtonMailMessage> {
	try {
		const teams = await contentTeams(account.id);
		return buildWelcomeEmail({ email: account.email, displayName: account.displayName, messageId: fresh.messageId, appUrl, teams });
	} catch (cause) {
		if (cause instanceof WelcomePreparationError && cause.category === 'invalid_membership') {
			await db.update(welcomeEmails).set({ state: 'suppressed', suppressionReason: cause.category, lastError: cause.category, nextRetryAt: null, claimToken: null, leaseExpiresAt: null }).where(and(owned, eq(welcomeEmails.state, 'claimed')));
		}
		throw cause;
	}
}

/** No SMTP before this durable boundary; abandoned preflight claims recover safely. */
async function prepareWelcome(userId: string, deadline: number, appUrl: string): Promise<Preparation> {
	const claimed = await claimWelcome(userId);
	if (!claimed) return { outcome: 'deferred' };
	const owned = and(key(userId), eq(welcomeEmails.claimToken, claimed.claimToken!));
	const account = await db.select().from(users).where(eq(users.id, userId)).get();
	const fresh = await db.select().from(welcomeEmails).where(owned).get();
	if (fresh?.state !== 'claimed') return { outcome: 'deferred' };
	const reason = exclusion(account, fresh);
	if (reason) {
		await db.update(welcomeEmails).set({ state: 'suppressed', suppressionReason: reason, nextRetryAt: null, claimToken: null, leaseExpiresAt: null }).where(owned);
		return { outcome: 'suppressed' };
	}
	if (!sendingEnabled() || Date.now() >= deadline) return deferPreparation(owned);
	const message = await buildClaimedMessage(owned, account!, fresh, appUrl);
	if (!await startSubmission(owned, account!, fresh)) return { outcome: 'deferred' };
	return { owned, fresh, message };
}

/** Fenced claim + fresh eligibility, followed by one bounded SMTP attempt. */
export async function deliverWelcome(userId: string, deadline: number): Promise<WelcomeDelivery> {
	if (!sendingEnabled() || Date.now() >= deadline) return 'deferred';
	let appUrl: string;
	try { appUrl = welcomeAppOrigin(env.APP_URL ?? ''); }
	catch { throw new WelcomePreparationError('configuration'); }
	const prepared = await prepareWelcome(userId, deadline, appUrl);
	if ('outcome' in prepared) return prepared.outcome;
	let result;
	try { result = await sendProtonMailEmail(prepared.message, deadline); }
	catch (cause) { return recordWelcomeFailure(prepared.owned, prepared.fresh, cause); }
	return recordWelcomeAcceptance(prepared.owned, result.messageId);
}

async function recoverClaim(row: WelcomeRow): Promise<number> {
	const uncertain = row.state === 'in_flight';
	const updated = await db.update(welcomeEmails).set({ state: uncertain ? 'ambiguous' : 'queued',
		lastError: uncertain ? 'abandoned_submission' : 'abandoned_claim', nextRetryAt: uncertain ? null : new Date().toISOString(), claimToken: null, leaseExpiresAt: null })
		.where(and(key(row.userId), eq(welcomeEmails.state, row.state), eq(welcomeEmails.claimToken, row.claimToken!), eq(welcomeEmails.leaseExpiresAt, row.leaseExpiresAt!)))
		.returning({ userId: welcomeEmails.userId });
	if (!uncertain || !updated.length) return 0;
	console.error(DIAGNOSTIC.abandoned);
	return 1;
}

async function recoverExpiredClaims(deadline: number): Promise<number> {
	const expired = await db.select().from(welcomeEmails).where(and(eq(welcomeEmails.campaign, WELCOME_CAMPAIGN),
		inArray(welcomeEmails.state, ['claimed', 'in_flight']), lte(welcomeEmails.leaseExpiresAt, new Date().toISOString()))).limit(25);
	let ambiguous = 0;
	for (const row of expired) {
		if (Date.now() >= deadline) break;
		// Deliberately serialized: avoid concurrent SQLite writers and check
		// the shared deadline before starting each bounded recovery write.
		ambiguous += await recoverClaim(row);
	}
	return ambiguous;
}

async function attemptNextWelcome(deadline: number): Promise<WelcomeDelivery> {
	const next = await db.select({ userId: welcomeEmails.userId }).from(welcomeEmails).where(due(new Date().toISOString()))
		.orderBy(asc(welcomeEmails.nextRetryAt), asc(welcomeEmails.userId)).limit(1).get();
	if (!next || Date.now() >= deadline) return 'deferred';
	try { return await deliverWelcome(next.userId, deadline); }
	catch (cause) { console.error(DIAGNOSTIC.processing, { category: welcomeFailureCategory(cause) }); return 'failed'; }
}

/** At most 25 enrollments, one send and 25 crash recoveries within the shared budget. */
async function sweepWelcomeQueue(deadline: number) {
	const counts = { scanned: 0, queued: 0, accepted: 0, errors: 0, ambiguous: 0, suppressed: 0 };
	if (!sendingEnabled() || Date.now() >= deadline) return counts;
	const unresolved = await db.select({ userId: welcomeEmails.userId }).from(welcomeEmails)
		.where(and(eq(welcomeEmails.campaign, WELCOME_CAMPAIGN), eq(welcomeEmails.state, 'ambiguous'))).limit(1).get();
	counts.ambiguous = unresolved ? 1 : 0;
	if (Date.now() >= deadline) return counts;
	counts.ambiguous = Math.min(1, counts.ambiguous + await recoverExpiredClaims(deadline));
	if (Date.now() >= deadline) return counts;
	Object.assign(counts, await enrollWelcomeCandidates(deadline));
	if (Date.now() >= deadline) return counts;
	const outcome = await attemptNextWelcome(deadline);
	const counter: Partial<Record<WelcomeDelivery, keyof typeof counts>> = { accepted: 'accepted', failed: 'errors', ambiguous: 'ambiguous', suppressed: 'suppressed' };
	const metric = counter[outcome];
	if (metric === 'ambiguous') counts.ambiguous = 1;
	else if (metric) counts[metric]++;
	return counts;
}


/** The cron response and both scheduler logs must never receive raw database errors. */
export async function sweepWelcomeEmails(deadline: number) {
	try { return await sweepWelcomeQueue(deadline); }
	catch (cause) {
		console.error(DIAGNOSTIC.processing, { category: welcomeFailureCategory(cause) });
		throw new Error('Welcome email sweep failed; inspect server diagnostics');
	}
}
