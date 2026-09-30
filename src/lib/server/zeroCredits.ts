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

import { and, asc, eq, inArray, isNotNull, isNull, notInArray, notLike, or, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';

import { effectiveBalanceSql, isUnmeteredPlan, paidSubscriptionPeriodExistsSql } from '$lib/server/billing/ledger';
import { isActiveSubscriptionStatus } from '$lib/server/billing/plans';
import { db } from '$lib/server/db';
import { memberships, mercadoPagoCheckoutAttempts, organizations, stripeCheckoutAttempts, users } from '$lib/server/db/schema';
import { deleteUserRecords, revokeChannelGrants, type DeletionTx, type ErasedChannelGrant } from '$lib/server/deletion';
import { escapeHtml } from '$lib/server/emailText';
import { assertBeforeDeadline, DeadlineExceededError } from '$lib/server/http';
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

/** Builds the post-deletion notice — sent only after the erase commits, best-effort. */
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
	subscriptionStatus: string | null;
	creditsRemaining: number | null;
	balance: number;
	/** EXISTS(...) → 0/1: the org ever received a paid subscription period. */
	hasPaidPeriod: number;
}

/**
 * A metered org is "unfunded" only when its effective balance is gone AND
 * no live subscription state says billing is active (a renewal invoice in
 * flight — 'past_due' — must never nuke the account mid-retry). 'unpaid' is
 * NOT live: Stripe stops attempting payments and access should be revoked
 * (docs/stripe-auto-topup.md §3.1), so it must not suppress the countdown
 * (codex).
 */
function orgIsUnfunded(org: OrgFunding): boolean {
	return org.balance <= 0 && !(isActiveSubscriptionStatus(org.subscriptionStatus) && org.subscriptionStatus !== 'unpaid');
}

interface SweepUser {
	id: string;
	email: string;
	displayName: string;
	since: string | null;
	notifiedAt: string | null;
	warnedAt: string | null;
}

type EvalOutcome = 'idle' | 'stamped' | 'cleared' | 'warned' | 'deleted';

function usageUrl(): string {
	const appUrl = env.APP_URL;
	if (!appUrl) throw new Error('APP_URL is not configured');
	return new URL('/usage', appUrl).toString();
}

async function sendMail(toEmail: string, toName: string, email: ZeroCreditEmail, deadline?: number): Promise<void> {
	await sendMailjetMessage(
		{ toEmail, toName, subject: email.subject, textPart: email.textPart, htmlPart: email.htmlPart },
		deadline
	);
}

/** The in-transaction funding guard found a funded account mid-erase. */
class AccountFundedError extends Error {}

/** A payment attempt in flight mid-erase — money may still land. */
class PaymentInFlightError extends Error {}

/**
 * An unresolved checkout can already be paid at the provider while local
 * fulfillment has not caught up. Its age cannot prove that it is unpaid:
 * delivery can fail beyond the provider's retry window, and a later retry
 * must still have an organization to credit or a refund obligation to resolve.
 *
 * Pending/open attempts shield until explicitly resolved, even if abandoned.
 * Never infer resolution from updatedAt. Keep this guard local so it can run
 * again under the erase transaction's write lock without remote calls.
 * Manual-refund obligations and unresolved Mercado Pago paid stamps also
 * protect the account regardless of age.
 */
async function hasInFlightPayment(
	userId: string,
	handle: Pick<typeof db, 'select'> | DeletionTx = db
): Promise<boolean> {
	const orgIds = (
		await handle
			.select({ id: organizations.id })
			.from(memberships)
			.innerJoin(organizations, eq(memberships.orgId, organizations.id))
			.where(eq(memberships.userId, userId))
			.all()
	).map((row) => row.id);
	if (!orgIds.length) return false;
	const stripeInFlight = await handle
		.select({ id: stripeCheckoutAttempts.id })
		.from(stripeCheckoutAttempts)
		.where(
			and(
				inArray(stripeCheckoutAttempts.orgId, orgIds),
				inArray(stripeCheckoutAttempts.status, ['pending', 'open', 'manual_refund_required'])
			)
		)
		.get();
	if (stripeInFlight) return true;
	const mpInFlight = await handle
		.select({ id: mercadoPagoCheckoutAttempts.id })
		.from(mercadoPagoCheckoutAttempts)
		.where(
			and(
				inArray(mercadoPagoCheckoutAttempts.orgId, orgIds),
				or(
					inArray(mercadoPagoCheckoutAttempts.status, ['pending', 'open', 'manual_refund_required']),
					// Provider-confirmed payment still unresolved: paidAt stamped but
					// the row never reached a terminal state — the money exists.
					and(
						isNotNull(mercadoPagoCheckoutAttempts.paidAt),
						notInArray(mercadoPagoCheckoutAttempts.status, ['fulfilled', 'refunded', 'disputed'])
					)
				)
			)
		)
		.get();
	return Boolean(mpInFlight);
}

/**
 * Reads the user's org funding and applies the metered/broke predicate.
 * 'corrupt' means a live user with zero memberships — a data bug, never a
 * deletion candidate. Any LIFETIME org exempts the whole account: Terms
 * §17.3 says lifetime orgs are never subject to zero-credit deletion, and
 * erasing the account would destroy the lifetime org's data — the exemption
 * is meaningless unless it protects the account (codex+coderabbit).
 *
 * `handle` lets the check run inside `deleteUserRecords`' erase transaction:
 * with the write lock held, a purchase committed between the sweep's
 * pre-check and the erase is either visible or blocked, so a funded account
 * can never be deleted (codex).
 */
async function fundingState(
	userId: string,
	nowIso: string,
	handle: Pick<typeof db, 'select'> | DeletionTx = db
): Promise<'broke' | 'funded' | 'corrupt'> {
	const orgs: OrgFunding[] = await handle
		.select({
			orgId: organizations.id,
			plan: organizations.plan,
			subscriptionStatus: organizations.stripeSubscriptionStatus,
			creditsRemaining: organizations.creditsRemaining,
			balance: effectiveBalanceSql(nowIso),
			hasPaidPeriod: paidSubscriptionPeriodExistsSql()
		})
		.from(memberships)
		.innerJoin(organizations, eq(memberships.orgId, organizations.id))
		.where(eq(memberships.userId, userId))
		.all();
	if (!orgs.length) return 'corrupt';
	if (orgs.some((org) => isUnmeteredPlan(org.plan))) return 'funded'; // lifetime exempts the account
	// 'broke' requires every BILLING-ENGAGED org unfunded. Engagement needs
	// real purchase evidence — the hosted plan, a granted balance, or a paid
	// subscription period. A bare stripeSubscriptionId is NOT evidence:
	// customer.subscription.created stores it for 'incomplete' subs whose
	// payment never succeeded, so a checkout that never converted would
	// otherwise land a never-purchased account in the deletion countdown
	// (codex — §17 applies only to billing-engaged accounts).
	const engaged = orgs.filter((org) => org.plan === 'hosted' || org.creditsRemaining !== null || org.hasPaidPeriod);
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
 *
 * `notified_at` is the CLAIM (a lease), never proof of delivery: a crash
 * between the claim and `sendMail` leaves it stamped with no mail sent —
 * that is why the deletion gate reads `warned_at`, which is stamped only
 * after the provider accepted the message (codex).
 */
async function claimAndWarn(user: SweepUser, since: string, sinceMs: number, nowIso: string, deadline?: number): Promise<EvalOutcome> {
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
			.set({ zeroCreditsSince: null, zeroCreditsNotifiedAt: null, zeroCreditsWarnedAt: null })
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
		// A spent budget throws here too — inside the try — so the milestone
		// claim releases and the warning retries next tick (codex).
		assertBeforeDeadline(deadline);
		await sendMail(user.email, user.displayName, email, deadline);
	} catch (cause) {
		await releaseWarningClaim(user, nowIso);
		throw cause;
	}
	// The provider accepted the message — record DELIVERY, distinct from the
	// claim. CAS on both stamps: a funded-clear or restamp that landed during
	// the send leaves the delivery unmarked rather than satisfying a
	// countdown that never got its warning (codex). A missed mark is safe:
	// the deletion gate reads `warned_at`, fails, and restarts the window.
	const marked = await db
		.update(users)
		.set({ zeroCreditsWarnedAt: nowIso })
		.where(and(eq(users.id, user.id), eq(users.zeroCreditsSince, since), eq(users.zeroCreditsNotifiedAt, nowIso)))
		.returning({ id: users.id });
	if (!marked.length) {
		console.warn(`zero-credit sweep: warning delivered to user ${user.id} but the countdown moved mid-send — delivery left unmarked`);
	}
	return 'warned';
}

/**
 * Claims the expired countdown (clearing `since` — only one concurrent run
 * wins), erases via the shared account-deletion path, revokes the account's
 * Google grants, and only then mails the completion notice — sent before
 * the commit, a failed erase would tell the user the account is gone while
 * it is still live (codex+coderabbit). If the delete throws the account
 * re-enters the queue with a fresh 30-day clock — an account is never
 * erased without the full warning window.
 */
async function claimAndDelete(user: SweepUser, since: string, ageMs: number, deadline?: number): Promise<EvalOutcome> {
	assertBeforeDeadline(deadline); // nothing claimed yet — a spent budget defers cleanly
	// A payment in flight can still fulfill — the webhook lands on an org this
	// erase would destroy. Deferring BEFORE the claim keeps the countdown
	// intact: if the attempt expires unpaid, the same clock still applies.
	if (await hasInFlightPayment(user.id)) {
		console.info(`zero-credit sweep: user ${user.id} has a payment in flight — deletion deferred, countdown preserved`);
		return 'idle';
	}
	// The claim clears all three stamps: every survivor of this path (funded,
	// abort, deadline, in-flight payment) starts the next countdown with a
	// clean slate — a kept claim or delivery marker would satisfy the next
	// window's deletion gate with no fresh warning ever sent (coderabbit).
	const claimed = await db
		.update(users)
		.set({ zeroCreditsSince: null, zeroCreditsNotifiedAt: null, zeroCreditsWarnedAt: null })
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
	assertBeforeDeadline(deadline); // the erase is the commit boundary — a spent budget must not cross it
	let grants: ErasedChannelGrant[];
	try {
		grants = await deleteUserRecords(user.id, {
			deadline,
			// The funding predicate re-runs INSIDE the erase transaction, under
			// the write lock: a purchase committed between the pre-check above
			// and here aborts the whole erase atomically (codex+coderabbit).
			assertDeletable: async (tx) => {
				if ((await fundingState(user.id, new Date().toISOString(), tx)) !== 'broke') {
					throw new AccountFundedError();
				}
				// Same race one level down: a checkout opened between the
				// pre-claim check and the erase commits under this lock — the
				// predicate re-runs on the tx handle so it sees (or blocks)
				// that write (codex).
				if (await hasInFlightPayment(user.id, tx)) {
					throw new PaymentInFlightError();
				}
			}
		});
	} catch (cause) {
		if (cause instanceof AccountFundedError) {
			console.info(`zero-credit sweep: user ${user.id} funded mid-deletion — erase aborted, account survives`);
			return 'cleared';
		}
		if (cause instanceof PaymentInFlightError) {
			// The claim already cleared both stamps — restore them so an
			// attempt that expires unpaid resumes the SAME countdown instead of
			// buying a fresh 30 days per deferral (codex). The CAS only fires
			// while the claim's cleared state still stands.
			await db
				.update(users)
				.set({ zeroCreditsSince: since, zeroCreditsNotifiedAt: user.notifiedAt, zeroCreditsWarnedAt: user.warnedAt })
				.where(and(eq(users.id, user.id), isNull(users.zeroCreditsSince), isNull(users.zeroCreditsNotifiedAt), isNull(users.zeroCreditsWarnedAt)));
			console.info(`zero-credit sweep: user ${user.id} payment arrived mid-deletion — erase aborted, countdown restored`);
			return 'idle';
		}
		throw cause;
	}
	// Post-commit revocation drains within the shared budget: each obligation
	// is durable in the revocation outbox, so a spent deadline defers loudly
	// to the cron retry instead of orphaning live Google grants (codex).
	await revokeChannelGrants(grants, 'zero-credit deletion', deadline);
	// The completion notice is best-effort — the erase is already committed;
	// a mail failure must not masquerade as a failed deletion.
	try {
		await sendMail(user.email, user.displayName, buildZeroCreditDeletedEmail({ name: user.displayName }), deadline);
	} catch (cause) {
		console.error('zero-credit sweep: post-deletion notice for user %s failed:', user.id, cause);
	}
	console.info(`zero-credit sweep: deleted account ${user.id} after ${Math.floor(ageMs / DAY_MS)} days at zero credits`);
	return 'deleted';
}

/**
 * Evaluates one live user against every org it belongs to. Returns the
 * transition applied this tick. `checked_at` is stamped first so even a
 * failing evaluation rotates to the back of the queue instead of hogging
 * the head of every batch.
 */
async function evaluateUser(user: SweepUser, deadline?: number): Promise<EvalOutcome> {
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
		// Clear only the countdown THIS evaluation read: a concurrent tick
		// that re-stamped `since` between the funding read and now owns a
		// fresh countdown this sweep must not erase (cubic).
		await db
			.update(users)
			.set({ zeroCreditsSince: null, zeroCreditsNotifiedAt: null, zeroCreditsWarnedAt: null })
			.where(and(eq(users.id, user.id), eq(users.zeroCreditsSince, user.since)));
		console.info(`zero-credit sweep: user ${user.id} is funded again — countdown cleared`);
		return 'cleared';
	}
	if (user.since === null) {
		// First broke observation stamps the clock only — the cadence rule
		// forbids an e-mail the day credits hit zero. Any warning stamp left
		// over from a previous countdown dies with the new clock (coderabbit).
		await db
			.update(users)
			.set({ zeroCreditsSince: nowIso, zeroCreditsNotifiedAt: null, zeroCreditsWarnedAt: null })
			.where(and(eq(users.id, user.id), isNull(users.zeroCreditsSince)));
		return 'stamped';
	}
	const sinceMs = Date.parse(user.since);
	if (Number.isNaN(sinceMs)) {
		console.error(`zero-credit sweep: user ${user.id} has an unparseable zero_credits_since (${user.since}) — skipped`);
		return 'idle';
	}
	const ageMs = Date.now() - sinceMs;
	if (user.notifiedAt !== null && Number.isNaN(Date.parse(user.notifiedAt))) {
		console.error(`zero-credit sweep: user ${user.id} has an unparseable zero_credits_notified_at (${user.notifiedAt}) — skipped`);
		return 'idle';
	}
	if (user.warnedAt !== null && Number.isNaN(Date.parse(user.warnedAt))) {
		console.error(`zero-credit sweep: user ${user.id} has an unparseable zero_credits_warned_at (${user.warnedAt}) — skipped`);
		return 'idle';
	}
	if (ageMs >= ZERO_CREDIT_GRACE_MS) {
		// The gate is `warned_at` — the DELIVERY marker, not the claim: a
		// crash after the claim but before the send leaves notified_at
		// stamped with no mail out, so trusting it would delete unwarned
		// accounts (codex). A stamp older than this countdown belongs to an
		// earlier cycle either way.
		const neverWarned = user.warnedAt === null || Date.parse(user.warnedAt) < sinceMs;
		if (neverWarned) {
			// Deletion requires a delivered warning — an account whose warnings
			// all failed to send (APP_URL missing, Mailjet down) must not be
			// erased on the bare clock. Restart the window so the promised
			// cadence can run; the release is conditional so a concurrent
			// sweep's warning claim still wins (codex+coderabbit).
			const restamped = await db
				.update(users)
				.set({ zeroCreditsSince: nowIso, zeroCreditsNotifiedAt: null, zeroCreditsWarnedAt: null })
				.where(
					and(
						eq(users.id, user.id),
						eq(users.zeroCreditsSince, user.since),
						user.notifiedAt === null
							? isNull(users.zeroCreditsNotifiedAt)
							: eq(users.zeroCreditsNotifiedAt, user.notifiedAt)
					)
				)
				.returning({ id: users.id });
			if (!restamped.length) return 'idle'; // a concurrent run claimed the milestone — it owns the outcome
			console.error(`zero-credit sweep: user ${user.id} reached the grace expiry with no delivered warning — restarting the warning window`);
			return 'stamped';
		}
		return claimAndDelete(user, user.since, ageMs, deadline);
	}
	if (ageMs >= ZERO_CREDIT_NOTICE_MS && (user.notifiedAt === null || Date.now() - Date.parse(user.notifiedAt) >= ZERO_CREDIT_NOTICE_MS)) {
		return claimAndWarn(user, user.since, sinceMs, nowIso, deadline);
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
			notifiedAt: users.zeroCreditsNotifiedAt,
			warnedAt: users.zeroCreditsWarnedAt
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
			const outcome = await evaluateUser(user, deadline);
			result.evaluated += 1;
			if (outcome === 'warned') result.warned += 1;
			else if (outcome === 'deleted') result.deleted += 1;
		} catch (cause) {
			// A spent budget is a scheduling condition, not a per-account
			// failure: stop cleanly without counting an error so the tick
			// reports budget exhaustion instead of a failed eval (codex).
			if (cause instanceof DeadlineExceededError) {
				console.error('zero-credit sweep: deadline reached mid-evaluation — deferring the remaining accounts');
				break;
			}
			result.errors += 1;
			console.error('zero-credit sweep: evaluation failed for user %s:', user.id, cause);
		}
	}
	return result;
}
