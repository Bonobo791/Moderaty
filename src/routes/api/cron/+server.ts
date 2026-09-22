// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { timingSafeEqual } from 'node:crypto';
import { error, json } from '@sveltejs/kit';
import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { nullExpiredConsentEmails, nullExpiredHandles, retryStripeCustomerDeletions } from '$lib/server/deletion';
import { sweepAutoTopUp } from '$lib/server/billing/autotopup';
import { sweepStalePendingReversals } from '$lib/server/billing/ledger';
import { DeadlineExceededError } from '$lib/server/http';
import { generateFeedbackDigest } from '$lib/server/feedbackDigest';
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
	if (!env.CRON_SECRET) throw error(500, 'CRON_SECRET is not configured');
	// Bearer header is the preferred path (used by the Netlify scheduled
	// function); the query param stays for the plan-documented manual curl.
	// A present-but-malformed Authorization header fails closed — query auth
	// is a separate mode only when no header was sent at all.
	const bearer = request.headers.get('authorization');
	let secret: string | null = null;
	if (bearer === null) secret = url.searchParams.get('secret');
	else if (bearer.startsWith('Bearer ')) secret = bearer.slice('Bearer '.length);
	if (!secretMatches(secret, env.CRON_SECRET)) throw error(401, 'bad secret');
}

/**
 * Runs one retention/top-up/outbox sweep. I8: a dry run changes nothing
 * durable (the would-be sweep is only logged). A sweep failure must never stop
 * scheduled moderation: it is logged loudly, reported in the payload, and
 * skipped — the handler continues.
 */
async function runSweep<T>(dryRun: boolean, label: string, run: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
	if (dryRun) {
		console.info(`dry run: ${label} skipped`);
		return { value: null, error: null };
	}
	try {
		return { value: await run(), error: null };
	} catch (cause) {
		console.error(`${label} failed:`, cause);
		return { value: null, error: cause instanceof Error ? cause.message : String(cause) };
	}
}

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
	// 'moderation' alone is too broad — YouTube moderation-ACTION failures
	// ("moderation action … verification failed", "moderationStatus is
	// unsupported") are provider errors, not AI scoring outages (cubic).
	if (/openai|scor(e|ing)|moderation (?:failed|returned|response)/.test(message)) return 'scoring';
	return 'error';
}

/**
 * Runs the claimed channel (one page), then the dry-run window drain while a
 * preview is in flight (I10 — bounded, same lease). A drain failure must never
 * mask the normal run — loud, surfaced in the payload, retried next
 * invocation.
 */
async function runClaimedChannel(
	channel: typeof channels.$inferSelect,
	deadline: number
): Promise<{ result: ChannelRunResult; dryRunWindow: unknown; digest: unknown }> {
	const result = await runChannel(channel.id, { deadline });
	let dryRunWindow: unknown;
	if (channel.dryRunBoundary) {
		try {
			const drain = await runChannel(channel.id, {
				deadline,
				forceDryRun: true,
				window: { boundary: channel.dryRunBoundary, pageToken: channel.dryRunPageToken ?? null }
			});
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
			dryRunWindow = drain;
		} catch (cause) {
			console.error('dry-run window drain failed for channel:', channel.id, cause);
			dryRunWindow = { error: cause instanceof Error ? cause.message : String(cause) };
		}
	}
	// The feedback digest piggybacks on the same lease and budget (I10): the
	// claimed channel generates one when its cadence is due and budget
	// remains. A digest failure must never mask the moderation verdict —
	// loud, surfaced in the payload, retried on the next claim.
	let digest: unknown;
	if (Date.now() < deadline) {
		try {
			digest = await generateFeedbackDigest(channel.id, { deadline });
		} catch (cause) {
			console.error(`feedback digest for channel ${channel.id} failed:`, cause);
			digest = { error: 'error' };
		}
	}
	return { result, dryRunWindow, digest };
}

export const GET: RequestHandler = async ({ url, request }) => {
	// Captured at handler start so the DB prelude consumes the same budget.
	const deadline = Date.now() + RUN_BUDGET_MS;
	authorizeCron(url, request);
	const dryRun = env.DRY_RUN === 'true';

	// Consent-evidence retention sweep runs first, while the full budget
	// remains: consent e-mails older than 10 years (CC Art. 205) are erased —
	// the row stays as anonymized evidence.
	const consent = await runSweep(dryRun, 'consent e-mail retention sweep', () => nullExpiredConsentEmails());
	// Commenter-handle retention sweep: handles on audit rows and staged
	// moderation actions older than 30 days are erased (the row and its
	// outcome stay as the moderation record).
	const handles = await runSweep(dryRun, 'commenter-handle retention sweep', () => nullExpiredHandles());
	const nowIso = new Date().toISOString();
	// Auto top-up sweep: the backstop for orgs whose balance dropped below
	// their threshold without an on-consume trigger. Bounded per invocation
	// (I10); under DRY_RUN nothing is charged.
	const autoTopup = await runSweep(dryRun, 'auto top-up sweep', () => sweepAutoTopUp(5, deadline));
	// Stripe deletion outbox retry: customers owed erasure from account
	// teardown whose first attempt hit a Stripe outage. Bounded per
	// invocation (I10); a row is removed only after Stripe confirms.
	const stripeDeletions = await runSweep(dryRun, 'stripe deletion outbox retry', () => retryStripeCustomerDeletions(10, deadline));
	// Stale pending-reversal sweep: refund/dispute obligations whose grant
	// never arrived within 14 days are dead weight — dropped loudly, bounded.
	const reversals = await runSweep(dryRun, 'pending-reversal sweep', () => sweepStalePendingReversals());

	// A failed sweep must never tick as success: ok reflects every sweep's
	// outcome (each failure is also surfaced in its own *Error field and logged).
	const base = {
		ok: !consent.error && !handles.error && !autoTopup.error && !stripeDeletions.error && !reversals.error,
		dryRun,
		consentEmailsNulled: consent.value ?? 0,
		sweepError: consent.error,
		auditHandlesNulled: handles.value?.auditLog ?? 0,
		actionHandlesNulled: handles.value?.moderationActions ?? 0,
		handleSweepError: handles.error,
		autoTopupsTriggered: autoTopup.value ?? 0,
		autoTopupSweepError: autoTopup.error,
		stripeCustomersDeleted: stripeDeletions.value ?? 0,
		stripeDeletionSweepError: stripeDeletions.error,
		pendingReversalsDropped: reversals.value ?? 0,
		pendingReversalSweepError: reversals.error
	};

	// The sweeps above consumed the budget; a channel run would abort
	// immediately on the expired deadline — report the sweeps, skip the claim.
	if (Date.now() >= deadline) return json({ ...base, results: {} });
	const claimable = or(isNull(channels.leaseExpiresAt), lt(channels.leaseExpiresAt, nowIso));
	const [channel] = await db
		.select()
		.from(channels)
		.where(and(eq(channels.active, 1), claimable))
		// Channels with a dry-run drain in flight first — a preview the user is
		// actively waiting on must not starve behind the ordinary rotation.
		.orderBy(desc(sql`${channels.dryRunBoundary} is not null`), asc(channels.lastRunAt))
		.limit(1);
	if (!channel) return json({ ...base, results: {} });

	// Atomic claim: a concurrent claimant's UPDATE matches 0 rows and exits cleanly.
	const claimed = await db
		.update(channels)
		.set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() })
		.where(and(eq(channels.id, channel.id), claimable))
		.returning({ id: channels.id });
	if (claimed.length === 0) return json({ ...base, claimed: false, results: {} });

	// The run's health verdict: a completed live run is 'success', a thrown or
	// incomplete one carries its sanitized category, and a run with no verdict
	// (dry run, paused mid-run, skipped as inactive) writes neither — stamping
	// success would lie, stamping failed/timeout would lie on resume
	// (codex+cubic).
	type RunCategory = 'token' | 'quota' | 'scoring' | 'timeout' | 'credits' | 'error';
	let runHealth: 'success' | 'none' | { status: 'failed'; error: RunCategory } = 'success';
	let body: Record<string, unknown>;
	let status = 200;
	try {
		const { result, dryRunWindow, digest } = await runClaimedChannel(channel, deadline);
		if (result.dryRun || result.stoppedReason === 'deactivated' || result.skipped) runHealth = 'none';
		else if (result.outOfCredits) runHealth = { status: 'failed', error: 'credits' };
		else if (result.partial) runHealth = { status: 'failed', error: 'timeout' };
		body = { ...base, results: { [channel.id]: result }, dryRunWindow, digest };
	} catch (cause) {
		const category = categorizeRunFailure(cause);
		runHealth = { status: 'failed', error: category };
		console.error(`channel run ${channel.id} failed:`, cause);
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
	return json(body, { status });
};
