// Zero-credit account retention (Terms §17, Privacy §7). A billing-engaged
// account — at least one METERED organization (hosted plan, subscription,
// or a credit balance ever granted) — enters a 30-day countdown the first
// time a sweep observes EVERY metered org unfunded. Warnings go out every
// 7 days — never on the day the balance hits zero — and the account is
// deleted (deleteUserRecords) at day 30 if it stays broke. Funding ANY
// metered org clears the clock. Unmetered orgs (never-purchased, lifetime —
// self-hosted included) are excluded from the test entirely: they can
// neither start the clock nor break it.
//
// Durable state lives on `users` (0047): `zero_credits_since` is the clock,
// `zero_credits_notified_at` the per-milestone claim, and
// `zero_credits_checked_at` the round-robin cursor (NULLs sort first, so
// never-evaluated users go first). Cron may overlap itself, so every
// transition is a conditional UPDATE — the loser matches 0 rows.

import { and, asc, eq, isNull, notLike, or, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';

import { effectiveBalanceSql, orgRowIsMetered } from '$lib/server/billing/ledger';
import { isActiveSubscriptionStatus } from '$lib/server/billing/plans';
import { db } from '$lib/server/db';
import { memberships, organizations, users } from '$lib/server/db/schema';
import { deleteUserRecords, revokeChannelGrantsForUser } from '$lib/server/deletion';
import { escapeHtml } from '$lib/server/emailText';
import { sendMailjetMessage } from '$lib/server/mailjet';

export const ZERO_CREDIT_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // countdown length (Terms §17)
export const ZERO_CREDIT_NOTICE_MS = 7 * 24 * 60 * 60 * 1000; // warning cadence — first at day 7, never at day 0
export const ZERO_CREDIT_SWEEP_BATCH = 25; // bounded per cron invocation (I10); rotation covers the rest

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ZeroCreditEmail {
	subject: string;
	textPart: string;
	htmlPart: string;
}

/**
 * Builds the 7-day warning e-mail. `daysLeft` is always in (0, 30]; the
 * deletion date makes the deadline concrete rather than relative-only.
 */
export function buildZeroCreditWarningEmail(input: {
	name: string;
	daysLeft: number;
	deletionDateIso: string;
	usageUrl: string;
}): ZeroCreditEmail {
	const subject = `Your Moderaty account will be deleted in ${input.daysLeft} days`;
	const textPart = [
		`Hi ${input.name},`,
		'',
		`Every organization on your Moderaty account has been out of moderation credits for over a week. Your account and its moderation data will be permanently deleted on ${input.deletionDateIso} — ${input.daysLeft} days from now — unless credits are added to at least one of your organizations.`,
		'',
		`Add credits or manage your plan here: ${input.usageUrl}`,
		'',
		'If no organization regains credits, the account is deleted automatically. There is nothing else to do if you meant to leave.',
		'',
		'— Moderaty'
	].join('\n');
	const htmlPart = [
		`<p>Hi ${escapeHtml(input.name)},</p>`,
		`<p>Every organization on your Moderaty account has been out of moderation credits for over a week. Your account and its moderation data will be permanently deleted on <strong>${escapeHtml(input.deletionDateIso)}</strong> — ${input.daysLeft} days from now — unless credits are added to at least one of your organizations.</p>`,
		`<p><a href="${escapeHtml(input.usageUrl)}">Add credits or manage your plan</a></p>`,
		'<p>If no organization regains credits, the account is deleted automatically. There is nothing else to do if you meant to leave.</p>',
		'<p>— Moderaty</p>'
	].join('');
	return { subject, textPart, htmlPart };
}

/** Builds the post-deletion notice — sent before the erase, best-effort. */
export function buildZeroCreditDeletedEmail(input: { name: string }): ZeroCreditEmail {
	const subject = 'Your Moderaty account has been deleted';
	const textPart = [
		`Hi ${input.name},`,
		'',
		'Your Moderaty account stayed at zero moderation credits for 30 days, so it has been permanently deleted as described in our Terms — organizations, moderation configuration, and history included.',
		'',
		'You can sign up again any time to start fresh.',
		'',
		'— Moderaty'
	].join('\n');
	const htmlPart = [
		`<p>Hi ${escapeHtml(input.name)},</p>`,
		'<p>Your Moderaty account stayed at zero moderation credits for 30 days, so it has been permanently deleted as described in our Terms — organizations, moderation configuration, and history included.</p>',
		'<p>You can sign up again any time to start fresh.</p>',
		'<p>— Moderaty</p>'
	].join('');
	return { subject, textPart, htmlPart };
}

interface OrgFunding {
	orgId: string;
	plan: string;
	stripeSubscriptionId: string | null;
	subscriptionStatus: string | null;
	creditsRemaining: number | null;
	balance: number;
}

/**
 * A metered org is "unfunded" only when its effective balance is gone AND
 * no live subscription state says billing is active (a renewal invoice in
 * flight — 'past_due'/'unpaid' — must never nuke the account mid-retry).
 */
function orgIsUnfunded(org: OrgFunding): boolean {
	return org.balance <= 0 && !isActiveSubscriptionStatus(org.subscriptionStatus);
}

interface SweepUser {
	id: string;
	email: string;
	displayName: string;
	since: string | null;
	notifiedAt: string | null;
}

type EvalOutcome = 'idle' | 'stamped' | 'cleared' | 'warned' | 'deleted';

function usageUrl(): string {
	const appUrl = env.APP_URL;
	if (!appUrl) throw new Error('APP_URL is not configured');
	return new URL('/usage', appUrl).toString();
}

async function sendMail(toEmail: string, toName: string, email: ZeroCreditEmail): Promise<void> {
	await sendMailjetMessage({ toEmail, toName, subject: email.subject, textPart: email.textPart, htmlPart: email.htmlPart });
}

/**
 * Reads the user's org funding and applies the metered/broke predicate.
 * 'corrupt' means a live user with zero memberships — a data bug, never a
 * deletion candidate.
 */
async function fundingState(userId: string, nowIso: string): Promise<'broke' | 'funded' | 'corrupt'> {
	const orgs: OrgFunding[] = await db
		.select({
			orgId: organizations.id,
			plan: organizations.plan,
			stripeSubscriptionId: organizations.stripeSubscriptionId,
			subscriptionStatus: organizations.stripeSubscriptionStatus,
			creditsRemaining: organizations.creditsRemaining,
			balance: effectiveBalanceSql(nowIso)
		})
		.from(memberships)
		.innerJoin(organizations, eq(memberships.orgId, organizations.id))
		.where(eq(memberships.userId, userId))
		.all();
	if (!orgs.length) return 'corrupt';
	const engaged = orgs.filter(orgRowIsMetered);
	return engaged.length > 0 && engaged.every(orgIsUnfunded) ? 'broke' : 'funded';
}

/** Releases a claimed warning milestone so a later rotation can retry the send. */
async function releaseWarningClaim(user: SweepUser, nowIso: string): Promise<void> {
	await db
		.update(users)
		.set({ zeroCreditsNotifiedAt: user.notifiedAt })
		.where(and(eq(users.id, user.id), eq(users.zeroCreditsNotifiedAt, nowIso)));
}

/**
 * Claims the current 7-day milestone before sending: the conditional UPDATE
 * only matches while the countdown stamp is unchanged and `notified_at` is
 * still due, so overlapping cron runs cannot double-send, and a concurrent
 * sweep's funded-clear revokes it. A failed send RESTORES the prior claim so
 * the warning retries next rotation — the milestone is never silently
 * consumed.
 */
async function claimAndWarn(user: SweepUser, since: string, sinceMs: number, nowIso: string): Promise<EvalOutcome> {
	const cutoffIso = new Date(Date.now() - ZERO_CREDIT_NOTICE_MS).toISOString();
	// Resolve the /usage link BEFORE claiming: a missing APP_URL throws here,
	// leaving the milestone due — claiming first would consume it unsent.
	const link = usageUrl();
	const claimed = await db
		.update(users)
		.set({ zeroCreditsNotifiedAt: nowIso })
		.where(
			and(
				eq(users.id, user.id),
				eq(users.zeroCreditsSince, since),
				or(isNull(users.zeroCreditsNotifiedAt), sql`${users.zeroCreditsNotifiedAt} <= ${cutoffIso}`)
			)
		)
		.returning({ id: users.id });
	if (!claimed.length) return 'idle'; // funded mid-read, or a concurrent run owns the milestone
	// The claim pins only the countdown stamp — a purchase lands on the org's
	// credits, never on `since`, so funding committed mid-evaluation is
	// invisible to the guard. Re-verify before the e-mail goes out: a top-up
	// racing this tick must not produce a warning for a now-funded account
	// (codeant).
	const state = await fundingState(user.id, nowIso);
	if (state === 'corrupt') {
		await releaseWarningClaim(user, nowIso);
		console.error(`zero-credit sweep: live user ${user.id} has no memberships — data bug, skipped`);
		return 'idle';
	}
	if (state === 'funded') {
		// We hold the claim (`since` is still ours to move): clear the clock
		// ourselves — the funded path would do it one rotation later anyway.
		await db
			.update(users)
			.set({ zeroCreditsSince: null, zeroCreditsNotifiedAt: null })
			.where(and(eq(users.id, user.id), eq(users.zeroCreditsSince, since)));
		console.info(`zero-credit sweep: user ${user.id} funded mid-warning — countdown cleared, no e-mail sent`);
		return 'cleared';
	}
	const daysLeft = Math.ceil((ZERO_CREDIT_GRACE_MS - (Date.now() - sinceMs)) / DAY_MS);
	const email = buildZeroCreditWarningEmail({
		name: user.displayName,
		daysLeft,
		deletionDateIso: new Date(sinceMs + ZERO_CREDIT_GRACE_MS).toISOString().slice(0, 10),
		usageUrl: link
	});
	try {
		await sendMail(user.email, user.displayName, email);
	} catch (cause) {
		await releaseWarningClaim(user, nowIso);
		throw cause;
	}
	return 'warned';
}

/**
 * Claims the expired countdown (clearing `since` — only one concurrent run
 * wins), sends the final notice best-effort, revokes the account's Google
 * grants, then erases via the shared account-deletion path. If the delete
 * throws the account re-enters the queue with a fresh 30-day clock — an
 * account is never erased without the full warning window.
 */
async function claimAndDelete(user: SweepUser, since: string, ageMs: number): Promise<EvalOutcome> {
	const claimed = await db
		.update(users)
		.set({ zeroCreditsSince: null })
		.where(and(eq(users.id, user.id), eq(users.zeroCreditsSince, since)))
		.returning({ id: users.id });
	if (!claimed.length) return 'idle'; // funded mid-read, or a concurrent run owns the deletion
	// Same claim race as claimAndWarn — a purchase lands on org credits, never
	// on `since`, so the guard could not see a top-up committed mid-evaluation
	// (codeant). The claim already cleared the clock, which is the correct
	// funded state; only a still-broke account proceeds to erasure.
	const state = await fundingState(user.id, new Date().toISOString());
	if (state !== 'broke') {
		if (state === 'corrupt') {
			console.error(`zero-credit sweep: live user ${user.id} has no memberships — data bug, skipped`);
		} else {
			console.info(`zero-credit sweep: user ${user.id} funded mid-deletion — account survives`);
		}
		return 'cleared';
	}
	try {
		await sendMail(user.email, user.displayName, buildZeroCreditDeletedEmail({ name: user.displayName }));
	} catch (cause) {
		console.error('zero-credit sweep: final notice for user %s failed — deleting anyway:', user.id, cause);
	}
	await revokeChannelGrantsForUser(user.id, 'zero-credit deletion');
	await deleteUserRecords(user.id);
	console.info(`zero-credit sweep: deleted account ${user.id} after ${Math.floor(ageMs / DAY_MS)} days at zero credits`);
	return 'deleted';
}

/**
 * Evaluates one live user against every org it belongs to. Returns the
 * transition applied this tick. `checked_at` is stamped first so even a
 * failing evaluation rotates to the back of the queue instead of hogging
 * the head of every batch.
 */
async function evaluateUser(user: SweepUser): Promise<EvalOutcome> {
	const nowIso = new Date().toISOString();
	await db.update(users).set({ zeroCreditsCheckedAt: nowIso }).where(eq(users.id, user.id));
	const state = await fundingState(user.id, nowIso);
	if (state === 'corrupt') {
		// Account creation inserts the personal-org membership in the same
		// transaction — a live user with none is corrupt data, never a
		// deletion candidate. Loud, skipped, re-evaluated each rotation.
		console.error(`zero-credit sweep: live user ${user.id} has no memberships — data bug, skipped`);
		return 'idle';
	}
	if (state === 'funded') {
		if (user.since === null) return 'idle';
		await db
			.update(users)
			.set({ zeroCreditsSince: null, zeroCreditsNotifiedAt: null })
			.where(eq(users.id, user.id));
		console.info(`zero-credit sweep: user ${user.id} is funded again — countdown cleared`);
		return 'cleared';
	}
	if (user.since === null) {
		// First broke observation stamps the clock only — the cadence rule
		// forbids an e-mail the day credits hit zero.
		await db
			.update(users)
			.set({ zeroCreditsSince: nowIso })
			.where(and(eq(users.id, user.id), isNull(users.zeroCreditsSince)));
		return 'stamped';
	}
	const sinceMs = Date.parse(user.since);
	if (Number.isNaN(sinceMs)) {
		console.error(`zero-credit sweep: user ${user.id} has an unparseable zero_credits_since (${user.since}) — skipped`);
		return 'idle';
	}
	const ageMs = Date.now() - sinceMs;
	if (ageMs >= ZERO_CREDIT_GRACE_MS) return claimAndDelete(user, user.since, ageMs);
	if (user.notifiedAt !== null && Number.isNaN(Date.parse(user.notifiedAt))) {
		console.error(`zero-credit sweep: user ${user.id} has an unparseable zero_credits_notified_at (${user.notifiedAt}) — skipped`);
		return 'idle';
	}
	if (ageMs >= ZERO_CREDIT_NOTICE_MS && (user.notifiedAt === null || Date.now() - Date.parse(user.notifiedAt) >= ZERO_CREDIT_NOTICE_MS)) {
		return claimAndWarn(user, user.since, sinceMs, nowIso);
	}
	return 'idle';
}

export interface ZeroCreditSweepResult {
	evaluated: number;
	warned: number;
	deleted: number;
	errors: number;
}

/**
 * Bounded round-robin sweep over live users (I10): each tick evaluates the
 * `limit` least-recently-checked accounts and stamps them, so coverage of
 * the whole table completes every ⌈users/limit⌉ invocations. Per-user
 * failures are logged with the user id and counted — they never abort the
 * batch or the rest of the cron tick.
 */
export async function sweepZeroCreditAccounts(limit = ZERO_CREDIT_SWEEP_BATCH, deadline?: number): Promise<ZeroCreditSweepResult> {
	const batch: SweepUser[] = await db
		.select({
			id: users.id,
			email: users.email,
			displayName: users.displayName,
			since: users.zeroCreditsSince,
			notifiedAt: users.zeroCreditsNotifiedAt
		})
		.from(users)
		// Tombstones are excluded by their google_sub marker, not by flags —
		// deleteUserRecords is the only writer of the shape.
		.where(notLike(users.googleSub, 'deleted:%'))
		// NULL checked_at first, then oldest — the stamp makes this a true
		// rotation rather than a front-of-queue rescan.
		.orderBy(asc(users.zeroCreditsCheckedAt), asc(users.id))
		.limit(limit)
		.all();
	const result: ZeroCreditSweepResult = { evaluated: 0, warned: 0, deleted: 0, errors: 0 };
	for (const user of batch) {
		if (deadline !== undefined && Date.now() >= deadline) break;
		try {
			const outcome = await evaluateUser(user);
			result.evaluated += 1;
			if (outcome === 'warned') result.warned += 1;
			else if (outcome === 'deleted') result.deleted += 1;
		} catch (cause) {
			result.errors += 1;
			console.error('zero-credit sweep: evaluation failed for user %s:', user.id, cause);
		}
	}
	return result;
}
