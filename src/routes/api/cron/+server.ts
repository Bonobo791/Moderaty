import { timingSafeEqual } from 'node:crypto';
import { error, json } from '@sveltejs/kit';
import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { nullExpiredConsentEmails, nullExpiredHandles, retryGoogleRevocations, retryStripeCustomerDeletions, retryStripeCustomerScrubs } from '$lib/server/deletion';
import { sweepAutoTopUp } from '$lib/server/billing/autotopup';
import { sweepStalePendingReversals } from '$lib/server/billing/ledger';
import { DeadlineExceededError } from '$lib/server/http';
import { generateFeedbackDigest } from '$lib/server/feedbackDigest';
import { sweepZeroCreditAccounts, ZERO_CREDIT_SWEEP_BATCH } from '$lib/server/zeroCredits';
import { runChannel, type ChannelRunResult } from '$lib/server/pipeline';
import type { RequestHandler } from './$types';

const LEASE_MS = 10 * 60 * 1000; // exceeds one bounded run; expiry alone re-eligibilizes after a crash
const RUN_BUDGET_MS = 20 * 1000; // below the scheduled trigger's 25s abort, so the server stops first

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

/**
 * Runs one retention/top-up/outbox sweep. I8: a dry run changes nothing
 * durable (the would-be sweep is only logged). A sweep failure must never stop
 * scheduled moderation: it is logged loudly, reported in the payload, and
 * skipped — the handler continues.
 */
const runSweep = async <T>(dryRun: boolean, label: string, run: () => Promise<T>): Promise<{ value: T | null; error: string | null }> => {
	if (dryRun) {
		console.info(`dry run: ${label} skipped`);
		return { value: null, error: null };
	}
	try {
		return { value: await run(), error: null };
	} catch (cause) {
		console.error('%s failed:', label, cause);
		return { value: null, error: cause instanceof Error ? cause.message : String(cause) };
	}
};

/**
 * Maps a run failure to the sanitized category persisted on the channel. The
 * full error is logged server-side; only this coarse reason reaches the
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
async function drainDryRunWindow(channel: typeof channels.$inferSelect, deadline: number): Promise<unknown> {
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
		console.error('dry-run window drain failed for channel:', channel.id, cause);
		return { error: cause instanceof Error ? cause.message : String(cause) };
	}
}

/**
 * The feedback digest piggybacks on the same lease and budget (I10): the
 * claimed channel generates one when its cadence is due — and a history
 * job in flight runs one bounded page here too — while budget remains.
 * A digest failure must never mask the moderation verdict — loud,
 * surfaced in the payload, retried on the next claim.
 */
async function runDueDigest(channel: typeof channels.$inferSelect, deadline: number): Promise<unknown> {
	if (Date.now() >= deadline) return undefined;
	try {
		return await generateFeedbackDigest(channel.id, { deadline });
	} catch (cause) {
		console.error('feedback digest failed for channel:', channel.id, cause);
		return { error: 'error' };
	}
}

async function runClaimedChannel(
	channel: typeof channels.$inferSelect,
	deadline: number
): Promise<{ result: ChannelRunResult; dryRunWindow: unknown; digest: unknown }> {
	const result = await runChannel(channel.id, { deadline, maxPages: 1 });
	const dryRunWindow = await drainDryRunWindow(channel, deadline);
	const digest = await runDueDigest(channel, deadline);
	return { result, dryRunWindow, digest };
}

const orZero = (value: number | null | undefined): number => value ?? 0;

/**
 * The maintenance sweeps that share the tick's budget, each isolated by
 * runSweep so one failure never stops the rest. Returns the `base` payload
 * the response builds on.
 */
const runCronSweeps = async (dryRun: boolean, deadline: number, startedAt: number) => {
	// Consent-evidence retention sweep runs first, while the full budget
	// remains: consent e-mails older than 10 years (CC Art. 205) are erased —
	// the row stays as anonymized evidence.
	const consent = await runSweep(dryRun, 'consent e-mail retention sweep', () => nullExpiredConsentEmails());
	// Commenter-handle retention sweep: handles on audit rows and staged
	// moderation actions older than 30 days are erased (the row and its
	// outcome stay as the moderation record).
	const handles = await runSweep(dryRun, 'commenter-handle retention sweep', () => nullExpiredHandles());
	// Auto top-up sweep: the backstop for orgs whose balance dropped below
	// their threshold without an on-consume trigger. Bounded per invocation
	// (I10); under DRY_RUN nothing is charged.
	const autoTopup = await runSweep(dryRun, 'auto top-up sweep', () => sweepAutoTopUp(5, deadline));
	// Stripe deletion outbox retry: customers owed erasure from account
	// teardown whose first attempt hit a Stripe outage. Bounded per
	// invocation (I10); a row is removed only after Stripe confirms.
	const stripeDeletions = await runSweep(dryRun, 'stripe deletion outbox retry', () => retryStripeCustomerDeletions(10, deadline));
	// Google revocation outbox retry: grants owed revocation from account
	// teardown are durable BEFORE the channel dies — a killed post-commit
	// drain must never orphan a live grant (codex). Bounded per invocation.
	const googleRevocations = await runSweep(dryRun, 'google revocation outbox retry', () => retryGoogleRevocations(10, deadline));
	// Stripe scrub outbox retry: surviving-org customers still carrying a
	// deleted user's e-mail — durable before commit, so a deadline-killed
	// post-commit drain retries here until Stripe confirms (codex). Bounded.
	const stripeScrubs = await runSweep(dryRun, 'stripe scrub outbox retry', () => retryStripeCustomerScrubs(10, deadline));
	// Stale pending-reversal sweep: refund/dispute obligations whose grant
	// never arrived within 14 days are dead weight — dropped loudly, bounded.
	const reversals = await runSweep(dryRun, 'pending-reversal sweep', () => sweepStalePendingReversals());
	// Zero-credit retention sweep: billing-engaged accounts whose orgs all ran
	// dry get stamped, warned every 7 days, and deleted at 30 (Terms §17).
	// Bounded per invocation (I10); under DRY_RUN no account is touched.
	const zeroCredit = await runSweep(dryRun, 'zero-credit account sweep', () => sweepZeroCreditAccounts(ZERO_CREDIT_SWEEP_BATCH, deadline));

	// A failed sweep must never tick as success: ok reflects every sweep's
	// outcome (each failure is also surfaced in its own *Error field and
	// logged). Per-account zero-credit eval failures count too — they ride
	// an answered 200 by design, so without them in `ok` a permanently
	// throwing evaluation would retry forever, invisible (codeant).
	const base = {
		ok: !consent.error && !handles.error && !autoTopup.error && !stripeDeletions.error && !googleRevocations.error && !stripeScrubs.error && !reversals.error && !zeroCredit.error && !zeroCredit.value?.errors,
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
		zeroCreditSweepError: zeroCredit.error
	};
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
	channel: typeof channels.$inferSelect,
	deadline: number,
	base: Record<string, unknown>,
	nowIso: string
): Promise<{ body: Record<string, unknown>; status: number }> => {
	let runHealth: 'success' | 'none' | { status: 'failed'; error: RunCategory } = 'success';
	let body: Record<string, unknown>;
	let status = 200;
	const runStartedAt = Date.now();
	try {
		const { result, dryRunWindow, digest } = await runClaimedChannel(channel, deadline);
		if (result.dryRun || result.stoppedReason === 'deactivated' || result.skipped) runHealth = 'none';
		else if (result.outOfCredits) runHealth = { status: 'failed', error: 'credits' };
		else if (result.partial) runHealth = { status: 'failed', error: 'timeout' };
		const health = typeof runHealth === 'string' ? runHealth : `failed:${runHealth.error}`;
		console.info(`cron: channel ${channel.id} finished in ${Date.now() - runStartedAt}ms — health=${health}`);
		body = { ...base, results: { [channel.id]: result }, dryRunWindow, digest };
	} catch (cause) {
		const category = categorizeRunFailure(cause);
		runHealth = { status: 'failed', error: category };
		console.error('channel run %s failed:', channel.id, cause);
		// The caller gets the sanitized category, never the raw provider
		// message — error bodies can echo request details/tokens (codeant).
		body = { ...base, ok: false, results: { [channel.id]: { error: category } } };
		status = 500; // failure must not look like success to the cron caller
	}
	// Record the run even on failure so a failing channel cannot starve the
	// others — but health is kept separate from the rotation timestamp
	// (MOD-7): a failure must not update the success fields. The write is
	// guarded by connector identity like assertChannelActive: a reconnect
	// mid-run replaces refreshTokenEnc, and the old run's verdict must not
	// land on the new connector (codex). A bookkeeping failure never masks
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
					eq(channels.refreshTokenEnc, channel.refreshTokenEnc)
				)
			)
			.returning({ id: channels.id });
		if (written.length === 0) {
			console.error('run-health write skipped: channel connector changed mid-run:', channel.id);
			body = { ...body, bookkeepingError: true };
		}
	} catch (writeCause) {
		console.error('run-health write failed for channel:', channel.id, writeCause);
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
	console.info(`cron: tick start (dryRun=${dryRun})`);
	const base = await runCronSweeps(dryRun, deadline, startedAt);
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
	const claimable = or(isNull(channels.leaseExpiresAt), lt(channels.leaseExpiresAt, nowIso));
	const [channel] = await db
		.select()
		.from(channels)
		.where(and(eq(channels.active, 1), claimable))
		// Channels with a dry-run drain in flight first — a preview the user is
		// actively waiting on must not starve behind the ordinary rotation.
		// History jobs get no such priority: a multi-page or stuck history
		// drain must never outrank least-recently-run moderation (codex+cubic).
		.orderBy(desc(sql`${channels.dryRunBoundary} is not null`), asc(channels.lastRunAt))
		.limit(1);
	if (!channel) {
		console.info('cron: no active, unleased channel to run');
		return json({ ...base, results: {} });
	}

	// Atomic claim: a concurrent claimant's UPDATE matches 0 rows and exits cleanly.
	const claimed = await db
		.update(channels)
		.set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() })
		.where(and(eq(channels.id, channel.id), claimable))
		.returning({ id: channels.id });
	if (claimed.length === 0) {
		console.info(`cron: lost claim race for channel ${channel.id}`);
		return json({ ...base, claimed: false, results: {} });
	}
	console.info(
		`cron: claimed channel ${channel.id} (lastRunAt=${channel.lastRunAt ?? 'never'}, cursor=${channel.cursor ?? 'none'}, resumingPage=${channel.nextPageToken !== null}, dryRunDrain=${channel.dryRunBoundary !== null})`
	);

	const { body, status } = await runAndRecord(channel, deadline, base, nowIso);
	return json(body, { status });
};
