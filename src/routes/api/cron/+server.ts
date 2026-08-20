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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { timingSafeEqual } from 'node:crypto';
import { error, json } from '@sveltejs/kit';
import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { nullExpiredConsentEmails, nullExpiredHandles, retryStripeCustomerDeletions } from '$lib/server/deletion';
import { sweepAutoTopUp } from '$lib/server/billing/autotopup';
import { sweepStalePendingReversals } from '$lib/server/billing/ledger';
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
 * Runs the claimed channel (one page), then the dry-run window drain while a
 * preview is in flight (I10 — bounded, same lease). A drain failure must never
 * mask the normal run — loud, surfaced in the payload, retried next
 * invocation.
 */
async function runClaimedChannel(
	channel: typeof channels.$inferSelect,
	deadline: number
): Promise<{ result: ChannelRunResult; dryRunWindow: unknown }> {
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
	return { result, dryRunWindow };
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

	try {
		const { result, dryRunWindow } = await runClaimedChannel(channel, deadline);
		return json({ ...base, results: { [channel.id]: result }, dryRunWindow });
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		console.error(`channel run ${channel.id} failed:`, cause);
		return json(
			{ ...base, ok: false, results: { [channel.id]: { error: message } } },
			{ status: 500 } // failure must not look like success to the cron caller
		);
	} finally {
		// Record the run even on failure so a failing channel cannot starve the others.
		await db
			.update(channels)
			.set({ leaseExpiresAt: null, lastRunAt: nowIso })
			.where(eq(channels.id, channel.id));
	}
};
