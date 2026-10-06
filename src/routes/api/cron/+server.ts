import { timingSafeEqual } from 'node:crypto';
import { error, json } from '@sveltejs/kit';
import { and, asc, eq, gte, inArray, isNull, lt, notInArray, or } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels, feedbackDigests } from '$lib/server/db/schema';
import { nullExpiredConsentEmails, nullExpiredHandles, retryGoogleRevocations, retryStripeCustomerDeletions, retryStripeCustomerScrubs } from '$lib/server/deletion';
import { sweepAutoTopUp } from '$lib/server/billing/autotopup';
import { sweepStalePendingReversals } from '$lib/server/billing/ledger';
import { CronDiagnostics } from '../../../../scripts/lib/cron-diagnostics.mjs';
import { DeadlineExceededError } from '$lib/server/http';
import { claimCronWorkload, releaseCronWorkload, PREVIEW_PENDING_STALE_MS, type CronWorkload } from '$lib/server/cronWorkload';
import { sweepWelcomeEmails } from '$lib/server/welcomeEmail';
import { retryContactNotifications } from '$lib/server/contactNotification';
import { generateFeedbackDigest, runFeedbackPreview } from '$lib/server/feedbackDigest';
import { sweepZeroCreditAccounts, ZERO_CREDIT_SWEEP_BATCH } from '$lib/server/zeroCredits';
import { runChannel, type ChannelRunResult } from '$lib/server/pipeline';
import type { RequestHandler } from './$types';

const CONTACT_NOTIFICATION_BUDGET_MS = 5 * 1000;
const RUN_BUDGET_MS = 20 * 1000; // below the scheduled trigger's 25s abort, so the server stops first
const STALE_PREVIEW_BATCH = 25; // an outage backlog finalizes across ticks — never one unbounded sweep (codex)

/** Constant-time secret comparison; never throws on length mismatch. */
function secretMatches(provided: string | null, expected: string): boolean {
	if (!provided) return false;
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One channel per invocation: the active, unleased channel with the oldest
 * lastRunAt (SQLite sorts NULLs first in ASC, so never-run channels go first).
 * The channel is claimed atomically with an expiring lease before runChannel,
 * so concurrent cron invocations cannot process the same channel.
 */
/** Verifies the cron caller: CRON_SECRET configured, then the bearer header or query secret. */
function authorizeCron(url: URL, request: Request): void {
	if (!env.CRON_SECRET) {
		console.error('cron: CRON_SECRET is not configured');
		throw error(500, 'CRON_SECRET is not configured');
	}
	// Bearer header is the preferred path (used by the Netlify scheduled
	// function); the query param stays for the plan-documented manual curl.
	// A present-but-malformed Authorization header fails closed — query auth
	// is a separate mode only when no header was sent at all.
	const bearer = request.headers.get('authorization');
	let secret: string | null = null;
	if (bearer === null) secret = url.searchParams.get('secret');
	else if (bearer.startsWith('Bearer ')) secret = bearer.slice('Bearer '.length);
	if (!secretMatches(secret, env.CRON_SECRET)) {
		const mode =
			bearer === null
				? secret === null
					? 'no credentials'
					: 'secret mismatch'
				: bearer.startsWith('Bearer ')
					? 'secret mismatch'
					: 'malformed Authorization header';
		console.warn(`cron: rejected request — ${mode}`);
		throw error(401, 'bad secret');
	}
}

type SweepResult<T> = { value: T | null; error: string | null };

/**
 * Runs one retention/top-up/outbox sweep. I8: a dry run changes nothing
 * durable (the would-be sweep is only logged). A sweep failure must never stop
 * scheduled moderation: it is logged loudly, reported in the payload, and
 * skipped — the handler continues.
 */
const runSweep = async <T>(dryRun: boolean, label: string, run: () => Promise<T>, diagnostics: CronDiagnostics): Promise<SweepResult<T>> => {
	if (dryRun) {
		console.info(`dry run: ${label} skipped`);
		return { value: null, error: null };
	}
	try {
		return { value: await run(), error: null };
	} catch (cause) {
		return { value: null, error: diagnostics.report(label, cause) };
	}
};

/**
 * Maps a run failure to the sanitized category persisted on the channel. The
 * allowlisted diagnostic is logged server-side; only this coarse reason reaches the
 * dashboard — provider error bodies can echo request details (tokens, keys)
 * and must never be stored. Order matters: a 403 naming 'quotaExceeded' is a
 * quota failure, not an auth one.
 */
function categorizeRunFailure(cause: unknown): 'token' | 'quota' | 'scoring' | 'timeout' | 'credits' | 'error' {
	if (cause instanceof DeadlineExceededError) return 'timeout';
	const message = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
	if (/quota|rate.?limit|429|too many/.test(message)) return 'quota';
	// 'token' alone is too broad — an expired PAGINATION token ("invalid page
	// token") is a transient provider error, not an auth failure, and the
	// dashboard would wrongly tell the user to reconnect (cubic+coderabbit).
	if (/unauthorized|invalid_grant|invalid_token|401|403|oauth|refresh token|access token|credential/.test(message)) return 'token';
	// 'moderation' alone is too broad — a YouTube moderation write failure is
	// a provider error, not an AI scoring outage.
	if (/openai|scor(e|ing)|moderation (?:failed|returned|response)/.test(message)) return 'scoring';
	return 'error';
}

/**
 * One dry-run window page under the claimed channel's lease (I10 — bounded).
 * A drain failure must never mask the normal run — loud, surfaced in the
 * payload, retried next invocation.
 */
async function drainDryRunWindow(channel: typeof channels.$inferSelect, deadline: number, diagnostics: CronDiagnostics): Promise<unknown> {
	if (!channel.dryRunBoundary) return undefined;
	try {
		const drain = await runChannel(channel.id, {
			deadline,
			forceDryRun: true,
			window: { boundary: channel.dryRunBoundary, pageToken: channel.dryRunPageToken ?? null }
		});
		console.info(`cron: dry-run drain for ${channel.id}: fetched=${drain.fetched} windowComplete=${drain.windowComplete}`);
		// Both writes are predicated on the boundary actually drained: the
		// row was read BEFORE the atomic claim, so a dashboard preview can
		// have replanted a new window in between — a stale drain must never
		// clear or overwrite the replacement state (0-row update = no-op).
		const drainedBoundary = eq(channels.dryRunBoundary, channel.dryRunBoundary);
		if (drain.windowComplete === true) {
			await db
				.update(channels)
				.set({ dryRunBoundary: null, dryRunPageToken: null })
				.where(and(eq(channels.id, channel.id), drainedBoundary));
		} else if (drain.windowComplete === false) {
			await db
				.update(channels)
				.set({ dryRunPageToken: drain.windowNextPageToken ?? null })
				.where(and(eq(channels.id, channel.id), drainedBoundary));
		}
		return drain;
	} catch (cause) {
		return { error: diagnostics.report('dry-run window drain', cause) };
	}
}

/**
 * Finalizes dead pending previews: a row past the stale window on a channel
 * with NO live lease is a crashed runner's leftover, not a queue. The lease
 * subquery keeps a mid-flight runner's row safe even after it crosses the
 * stale mark — 'dry-run-failed' is terminal and the user's one free preview
 * must not burn on a race (cubic+codex). Rows on deleted channels still
 * finalize (their id simply isn't in the leased set). Bounded per tick: an
 * outage backlog drains across invocations instead of eating one tick's
 * budget (codex). The id subquery is part of the UPDATE, so the lease check
 * re-evaluates atomically with the write.
 */
async function finalizeStalePreviews(nowIso: string, staleBefore: string): Promise<number> {
	const drainableChannels = db.select({ id: channels.id }).from(channels).where(eq(channels.active, 1));
	const leasedChannels = db.select({ id: channels.id }).from(channels).where(gte(channels.leaseExpiresAt, nowIso));
	const staleIds = db
		.select({ id: feedbackDigests.id })
		.from(feedbackDigests)
		.where(
			and(
				eq(feedbackDigests.status, 'dry-run-pending'),
				// A live lease may belong to an in-flight runner — never
				// finalize under it (cubic+codex).
				notInArray(feedbackDigests.channelId, leasedChannels),
				or(
					// A row on a deleted or paused channel can never satisfy the
					// drainer's join — finalize regardless of attempt state. A
					// kicked runner would fail ERR_PREVIEW_PAUSED anyway, so
					// pausing already kills the preview; 'pending forever' is a
					// lie the feed would render (codex).
					notInArray(feedbackDigests.channelId, drainableChannels),
					// Attempted but never finished = a dead runner's leftover.
					// NULL attempted_at rows are queued, never claimed — the
					// stale window must not expire a preview before its first
					// scheduler opportunity (codex).
					lt(feedbackDigests.attemptedAt, staleBefore)
				)
			)
		)
		.orderBy(asc(feedbackDigests.id))
		.limit(STALE_PREVIEW_BATCH);
	const stale = await db
		.update(feedbackDigests)
		// 'dry-run-failed' is terminal and outside transient digest state —
		// later runs can neither anchor on it nor sweep it (gitar PR 170).
		.set({ status: 'dry-run-failed', error: 'preview-timeout' })
		.where(and(eq(feedbackDigests.status, 'dry-run-pending'), inArray(feedbackDigests.id, staleIds)))
		.returning({ id: feedbackDigests.id, channelId: feedbackDigests.channelId });
	for (const row of stale) {
		console.error(`cron: feedback preview ${row.id} for channel ${row.channelId} sat pending past ${PREVIEW_PENDING_STALE_MS}ms — finalized 'dry-run-failed'`);
	}
	return stale.length;
}

/** Runs the preview already selected by the fair scheduler under its lease. */
async function runClaimedFeedbackPreview(
	pending: Extract<CronWorkload, { kind: 'preview' }>,
	deadline: number,
	staleFailed: number,
	diagnostics: CronDiagnostics
): Promise<unknown> {
	const stalePayload = staleFailed ? { staleFailed } : {};
	const lease = pending.leaseExpiresAt;
	try {
		const preview = await runFeedbackPreview(pending.channel.id, pending.digest.id, {
			boundary: pending.digest.windowStart,
			deadline,
			// Bind the run to the fingerprint we claimed: a reconnect between
			// the pending select and the run swapped the connector under the
			// same id, and this preview must abort rather than execute on the
			// wrong org — same binding as the user-triggered path (cubic).
			claim: {
				orgId: pending.channel.orgId,
				refreshTokenEnc: pending.channel.refreshTokenEnc,
				leaseExpiresAt: lease
			}
		});
		console.info('cron: feedback preview %s for %s finished — classified=%d', pending.digest.id, pending.channel.id, preview.commentsClassified);
		return {
			// Operational counts only — `findings` carry near-verbatim
			// commenter excerpts persisted for the feed; the scheduler
			// drivers log this response, so evidence never crosses the
			// cron boundary (codex).
			commentsClassified: preview.commentsClassified,
			commentsFailed: preview.commentsFailed,
			...(preview.clusteringDegraded ? { clusteringDegraded: true } : {}),
			pooled: preview.pooled,
			hasMore: preview.hasMore,
			...stalePayload
		};
	} catch (cause) {
		// DeadlineExceededError leaves the row pending — a later tick resumes
		// it until the stale age-out stops a dead run retrying forever. Other
		// failures already wrote 'dry-run-failed' inside the runner. Only the
		// sanitized category reaches the payload (codeant).
		diagnostics.report('feedback preview', cause);
		return { error: cause instanceof DeadlineExceededError ? 'timeout' : 'error', ...stalePayload };
	} finally {
		// Release only OUR lease — an expired lease reclaimed by the rotation
		// or another tick is untouched. A release failure must not override
		// the result: the lease self-expires, and this invocation still ran
		// its one workload even if bookkeeping fails.
		try {
			await releaseCronWorkload(pending);
		} catch (releaseCause) {
			diagnostics.report('lease release', releaseCause);
		}
	}
}

/**
 * The feedback digest piggybacks on the same lease and budget (I10): the
 * claimed channel generates one when its cadence is due — and a history
 * job in flight runs one bounded page here too — while budget remains.
 * A digest failure must never mask the moderation verdict — loud,
 * surfaced in the payload, retried on the next claim.
 */
async function runDueDigest(channel: typeof channels.$inferSelect, deadline: number, diagnostics: CronDiagnostics): Promise<unknown> {
	if (Date.now() >= deadline) return undefined;
	try {
		return await generateFeedbackDigest(channel.id, { deadline });
	} catch (cause) {
		diagnostics.report('feedback digest', cause);
		return { error: 'error' };
	}
}

async function runClaimedChannel(
	channel: typeof channels.$inferSelect,
	deadline: number,
	diagnostics: CronDiagnostics
): Promise<{ result: ChannelRunResult; dryRunWindow: unknown; digest: unknown }> {
	const result = await runChannel(channel.id, { deadline, maxPages: 1 });
	const dryRunWindow = await drainDryRunWindow(channel, deadline, diagnostics);
	const digest = await runDueDigest(channel, deadline, diagnostics);
	return { result, dryRunWindow, digest };
}

const orZero = (value: number | null | undefined): number => value ?? 0;

type CronSweepResults = {
	contactNotifications: SweepResult<Awaited<ReturnType<typeof retryContactNotifications>>>;
	welcome: SweepResult<Awaited<ReturnType<typeof sweepWelcomeEmails>>>;
	consent: SweepResult<Awaited<ReturnType<typeof nullExpiredConsentEmails>>>;
	handles: SweepResult<Awaited<ReturnType<typeof nullExpiredHandles>>>;
	autoTopup: SweepResult<Awaited<ReturnType<typeof sweepAutoTopUp>>>;
	stripeDeletions: SweepResult<Awaited<ReturnType<typeof retryStripeCustomerDeletions>>>;
	googleRevocations: SweepResult<Awaited<ReturnType<typeof retryGoogleRevocations>>>;
	stripeScrubs: SweepResult<Awaited<ReturnType<typeof retryStripeCustomerScrubs>>>;
	reversals: SweepResult<Awaited<ReturnType<typeof sweepStalePendingReversals>>>;
	zeroCredit: SweepResult<Awaited<ReturnType<typeof sweepZeroCreditAccounts>>>;
};

function cronSweepPayload(sweeps: CronSweepResults, dryRun: boolean, diagnostics: CronDiagnostics) {
	const { contactNotifications, welcome, consent, handles, autoTopup, stripeDeletions, googleRevocations, stripeScrubs, reversals, zeroCredit } = sweeps;
	const failures = [
		...Object.values(sweeps).map((sweep) => sweep.error), welcome.value?.enrollmentErrors, welcome.value?.errors,
		welcome.value?.ambiguous, zeroCredit.value?.errors, contactNotifications.value?.errors
	];
	// A failed sweep must never tick as success: ok reflects every sweep's
	// outcome (each failure is also surfaced in its own *Error field and
	// logged). Per-account zero-credit eval failures count too — they ride
	// an answered 200 by design, so without them in `ok` a permanently
	// throwing evaluation would retry forever, invisible (codeant).
	return {
		cronRunId: diagnostics.cronRunId,
		failureDiagnostics: diagnostics.failures,
		ok: failures.every((failure) => !failure),
		dryRun,
		consentEmailsNulled: orZero(consent.value),
		sweepError: consent.error,
		auditHandlesNulled: orZero(handles.value?.auditLog),
		actionHandlesNulled: orZero(handles.value?.moderationActions),
		handleSweepError: handles.error,
		autoTopupsTriggered: orZero(autoTopup.value),
		autoTopupSweepError: autoTopup.error,
		stripeCustomersDeleted: orZero(stripeDeletions.value),
		stripeDeletionSweepError: stripeDeletions.error,
		googleGrantsRevoked: orZero(googleRevocations.value),
		googleRevocationSweepError: googleRevocations.error,
		stripeCustomersScrubbed: orZero(stripeScrubs.value),
		stripeScrubSweepError: stripeScrubs.error,
		pendingReversalsDropped: orZero(reversals.value),
		pendingReversalSweepError: reversals.error,
		zeroCreditAccountsChecked: orZero(zeroCredit.value?.evaluated),
		zeroCreditWarningsSent: orZero(zeroCredit.value?.warned),
		zeroCreditAccountsDeleted: orZero(zeroCredit.value?.deleted),
		zeroCreditItemErrors: orZero(zeroCredit.value?.errors),
		zeroCreditSweepError: zeroCredit.error,
		contactNotificationsSent: orZero(contactNotifications.value?.sent),
		contactNotificationErrors: orZero(contactNotifications.value?.errors),
		contactNotificationSweepError: contactNotifications.error,
		welcomeEmailCandidatesScanned: orZero(welcome.value?.scanned),
		welcomeEmailsQueued: orZero(welcome.value?.queued),
		welcomeEmailEnrollmentErrors: orZero(welcome.value?.enrollmentErrors),
		welcomeEmailsAccepted: orZero(welcome.value?.accepted),
		welcomeEmailErrors: orZero(welcome.value?.errors),
		welcomeEmailAmbiguous: orZero(welcome.value?.ambiguous),
		welcomeEmailSuppressed: orZero(welcome.value?.suppressed),
		welcomeEmailSweepError: welcome.error
	};
}

/**
 * The maintenance sweeps that share the tick's budget, each isolated by
 * runSweep so one failure never stops the rest. Returns the `base` payload
 * the response builds on.
 */
const runCronSweeps = async (dryRun: boolean, deadline: number, startedAt: number, diagnostics: CronDiagnostics) => {
	// Give one due contact request an early opportunity without consuming
	// more than five seconds of the shared 20-second maintenance/run budget.
	const contactDeadline = Math.min(deadline, Date.now() + CONTACT_NOTIFICATION_BUDGET_MS);
	const contactNotifications = await runSweep(dryRun, 'contact notification retry', () => retryContactNotifications(contactDeadline), diagnostics);
	const welcomeDeadline = Math.min(deadline, Date.now() + 5_000);
	const welcome = await runSweep(dryRun, 'hosted welcome email sweep', () => sweepWelcomeEmails(welcomeDeadline), diagnostics);
	// Consent-evidence retention sweep runs first, while the full budget
	// remains: consent e-mails older than 10 years (CC Art. 205) are erased —
	// the row stays as anonymized evidence.
	const consent = await runSweep(dryRun, 'consent e-mail retention sweep', () => nullExpiredConsentEmails(), diagnostics);
	// Commenter-handle retention sweep: handles on audit rows and staged
	// moderation actions older than 30 days are erased (the row and its
	// outcome stay as the moderation record).
	const handles = await runSweep(dryRun, 'commenter-handle retention sweep', () => nullExpiredHandles(), diagnostics);
	// Auto top-up sweep: the backstop for orgs whose balance dropped below
	// their threshold without an on-consume trigger. Bounded per invocation
	// (I10); under DRY_RUN nothing is charged.
	const autoTopup = await runSweep(dryRun, 'auto top-up sweep', () => sweepAutoTopUp(5, deadline), diagnostics);
	// Stripe deletion outbox retry: customers owed erasure from account
	// teardown whose first attempt hit a Stripe outage. Bounded per
	// invocation (I10); a row is removed only after Stripe confirms.
	const stripeDeletions = await runSweep(dryRun, 'stripe deletion outbox retry', () => retryStripeCustomerDeletions(10, deadline), diagnostics);
	// Google revocation outbox retry: grants owed revocation from account
	// teardown are durable BEFORE the channel dies — a killed post-commit
	// drain must never orphan a live grant (codex). Bounded per invocation.
	const googleRevocations = await runSweep(dryRun, 'google revocation outbox retry', () => retryGoogleRevocations(10, deadline), diagnostics);
	// Stripe scrub outbox retry: surviving-org customers still carrying a
	// deleted user's e-mail — durable before commit, so a deadline-killed
	// post-commit drain retries here until Stripe confirms (codex). Bounded.
	const stripeScrubs = await runSweep(dryRun, 'stripe scrub outbox retry', () => retryStripeCustomerScrubs(10, deadline), diagnostics);
	// Stale pending-reversal sweep: refund/dispute obligations whose grant
	// never arrived within 14 days are dead weight — dropped loudly, bounded.
	const reversals = await runSweep(dryRun, 'pending-reversal sweep', () => sweepStalePendingReversals(), diagnostics);
	// Zero-credit retention sweep: billing-engaged accounts whose orgs all ran
	// dry get stamped, warned every 7 days, and deleted at 30 (Terms §17).
	// Bounded per invocation (I10); under DRY_RUN no account is touched.
	const zeroCredit = await runSweep(dryRun, 'zero-credit account sweep', () => sweepZeroCreditAccounts(ZERO_CREDIT_SWEEP_BATCH, deadline), diagnostics);

	const base = cronSweepPayload({ contactNotifications, welcome, consent, handles, autoTopup, stripeDeletions, googleRevocations, stripeScrubs, reversals, zeroCredit }, dryRun, diagnostics);
	console.info(`cron: sweeps finished in ${Date.now() - startedAt}ms`);
	return base;
};

type RunCategory = 'token' | 'quota' | 'scoring' | 'timeout' | 'credits' | 'error';

/**
 * Runs the claimed channel and writes its bookkeeping row. The run's health
 * verdict: a completed live run is 'success', a thrown or incomplete one
 * carries its sanitized category, and a run with no verdict (dry run, paused
 * mid-run, skipped as inactive) writes neither — stamping success would lie,
 * stamping failed/timeout would lie on resume (codex+cubic).
 */
const runAndRecord = async (
	claim: Extract<CronWorkload, { kind: 'live' }>,
	deadline: number,
	base: Record<string, unknown>,
	diagnostics: CronDiagnostics
): Promise<{ body: Record<string, unknown>; status: number }> => {
	const { channel, nowIso, leaseExpiresAt } = claim;
	let runHealth: 'success' | 'none' | { status: 'failed'; error: RunCategory } = 'success';
	let body: Record<string, unknown>;
	let status = 200;
	const runStartedAt = Date.now();
	try {
		const { result, dryRunWindow, digest } = await runClaimedChannel(channel, deadline, diagnostics);
		if (result.dryRun || result.stoppedReason === 'deactivated' || result.skipped) runHealth = 'none';
		else if (result.outOfCredits) runHealth = { status: 'failed', error: 'credits' };
		else if (result.partial) runHealth = { status: 'failed', error: 'timeout' };
		const health = typeof runHealth === 'string' ? runHealth : `failed:${runHealth.error}`;
		console.info(`cron: channel ${channel.id} finished in ${Date.now() - runStartedAt}ms — health=${health}`);
		body = { ...base, results: { [channel.id]: result }, dryRunWindow, digest };
	} catch (cause) {
		const category = categorizeRunFailure(cause);
		runHealth = { status: 'failed', error: category };
		diagnostics.report('channel run', cause);
		// The caller gets the sanitized category, never the raw provider
		// message — error bodies can echo request details/tokens (codeant).
		body = { ...base, ok: false, results: { [channel.id]: { error: category } } };
		status = 500; // failure must not look like success to the cron caller
	}
	// Record the run even on failure so a failing channel cannot starve the
	// others — but health is kept separate from the rotation timestamp
	// (MOD-7): a failure must not update the success fields. The write is
	// guarded by connector identity and the claimed lease: a reconnect or
	// expired lease reclaimed by another runner must not receive the old
	// run's verdict or have its newer lease cleared. A bookkeeping failure never masks
	// the run result but IS flagged in the payload — a server-log-only
	// fallback would hide the degraded state (codeant+codex); the lease
	// self-expires either way.
	try {
		const written = await db
			.update(channels)
			.set({
				leaseExpiresAt: null,
				lastRunAt: nowIso,
				...(runHealth === 'success'
					? { lastRunStatus: 'success', lastRunError: null, lastSuccessAt: nowIso }
					: runHealth === 'none'
						? {}
						: { lastRunStatus: runHealth.status, lastRunError: runHealth.error })
			})
			.where(
				and(
					eq(channels.id, channel.id),
					channel.userId === null ? isNull(channels.userId) : eq(channels.userId, channel.userId),
					eq(channels.refreshTokenEnc, channel.refreshTokenEnc),
					eq(channels.leaseExpiresAt, leaseExpiresAt)
				)
			)
			.returning({ id: channels.id });
		if (written.length === 0) {
			diagnostics.report('run-health bookkeeping', new Error('Connector or lease changed'));
			body = { ...body, bookkeepingError: true };
		}
	} catch (writeCause) {
		diagnostics.report('run-health bookkeeping', writeCause);
		body = { ...body, bookkeepingError: true };
	}
	return { body, status };
};

export const GET: RequestHandler = async ({ url, request }) => {
	// Captured at handler start so the DB prelude consumes the same budget.
	const startedAt = Date.now();
	const deadline = startedAt + RUN_BUDGET_MS;
	authorizeCron(url, request);
	// Validate BEFORE any sweep or claim: an invalid value must fail loudly
	// at the entry, not silently run the sweeps live (runChannel re-checks,
	// but by then retention writes would already have landed).
	if (env.DRY_RUN !== 'true' && env.DRY_RUN !== 'false') {
		throw error(500, 'DRY_RUN must be true or false');
	}
	const dryRun = env.DRY_RUN === 'true';
	const diagnostics = new CronDiagnostics();
	console.info(`cron: tick start (dryRun=${dryRun}, run=${diagnostics.cronRunId})`);
	const base = await runCronSweeps(dryRun, deadline, startedAt, diagnostics);
	const nowIso = new Date().toISOString();

	// The sweeps above consumed the budget; a channel run would abort
	// immediately on the expired deadline — report the sweeps, skip the claim.
	if (Date.now() >= deadline) {
		const elapsedMs = Date.now() - startedAt;
		console.error(
			`cron: sweeps consumed the ${RUN_BUDGET_MS}ms run budget (${elapsedMs}ms) — no channel claimed this tick`
		);
		return json({ ...base, budgetExhausted: true, results: {} });
	}
	let workload: CronWorkload;
	let staleFailed = 0;
	let feedbackPreviewSweepError = false;
	try {
		staleFailed = await finalizeStalePreviews(nowIso, new Date(Date.now() - PREVIEW_PENDING_STALE_MS).toISOString());
	} catch (cause) {
		diagnostics.report('stale feedback preview cleanup', cause);
		feedbackPreviewSweepError = true;
	}
	const afterCleanup = { ...base, ...(feedbackPreviewSweepError ? { ok: false, feedbackPreviewSweepError } : {}) };
	try {
		workload = await claimCronWorkload(deadline);
	} catch (cause) {
		// A transaction failure rolls back the lease and turn together. Fail
		// loudly rather than guessing which workload another tick owns.
		diagnostics.report('workload claim', cause);
		return json({ ...afterCleanup, ok: false, schedulerError: true, results: {} }, { status: 500 });
	}
	const withPreview = { ...afterCleanup, feedbackPreview: staleFailed ? { staleFailed } : undefined };
	if (workload.kind === 'budget-exhausted') {
		console.error(`cron: workload selection consumed the ${RUN_BUDGET_MS}ms run budget — no channel claimed this tick`);
		return json({ ...withPreview, budgetExhausted: true, results: {} });
	}
	if (workload.kind === 'none') {
		console.info('cron: no active, unleased channel to run');
		return json({ ...withPreview, results: {} });
	}
	if (workload.kind === 'claim-lost') {
		console.info(`cron: lost claim race for channel ${workload.channelId}`);
		return json({ ...withPreview, claimed: false, results: {} });
	}
	// Even a short transaction can return after its deadline (remote DB
	// latency or lock contention). Never start remote work or stamp live
	// health on that spent budget. The committed claim spent its turn;
	// resetting the shared turn here could overwrite a concurrent claimant.
	if (Date.now() >= deadline) {
		console.error('cron: claim finished after the run budget — skipping workload');
		let bookkeepingError = false;
		try {
			await releaseCronWorkload(workload);
		} catch (cause) {
			diagnostics.report('lease release', cause);
			bookkeepingError = true;
		}
		return json({ ...withPreview, budgetExhausted: true, ...(bookkeepingError ? { bookkeepingError } : {}), results: {} });
	}
	// Exactly one selected workload shares the original deadline. A retry or
	// failure still spends this class's turn; the next tick serves its peer.
	if (workload.kind === 'preview') {
		const feedbackPreview = await runClaimedFeedbackPreview(workload, deadline, staleFailed, diagnostics);
		return json({ ...afterCleanup, feedbackPreview, results: {} });
	}
	const { channel } = workload;
	console.info(
		`cron: claimed channel ${channel.id} (lastRunAt=${channel.lastRunAt ?? 'never'}, cursor=${channel.cursor ?? 'none'}, resumingPage=${channel.nextPageToken !== null}, dryRunDrain=${channel.dryRunBoundary !== null})`
	);
	const { body, status } = await runAndRecord(workload, deadline, withPreview, diagnostics);
	return json(body, { status });
};
