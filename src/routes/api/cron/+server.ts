// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
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
import { runChannel } from '$lib/server/pipeline';
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
export const GET: RequestHandler = async ({ url, request }) => {
	// Captured at handler start so the DB prelude consumes the same budget.
	const deadline = Date.now() + RUN_BUDGET_MS;
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
	const dryRun = env.DRY_RUN === 'true';
	// Consent-evidence retention sweep runs first, while the full budget
	// remains: consent e-mails older than 10 years (CC Art. 205) are erased —
	// the row stays as anonymized evidence. I8: a dry run changes nothing
	// durable — the would-be sweep is only logged. A sweep failure must not
	// stop scheduled moderation: log it loudly, report it, continue.
	let consentEmailsNulled = 0;
	let sweepError: string | null = null;
	if (dryRun) {
		console.info('dry run: consent e-mail retention sweep skipped');
	} else {
		try {
			consentEmailsNulled = await nullExpiredConsentEmails();
		} catch (cause) {
			sweepError = cause instanceof Error ? cause.message : String(cause);
			console.error('consent e-mail retention sweep failed:', cause);
		}
	}
	// Commenter-handle retention sweep: handles on audit rows and staged
	// moderation actions older than 30 days are erased (the row and its
	// outcome stay as the moderation record). Same rules as the consent sweep
	// above: nothing durable under DRY_RUN (I8), and a failure is logged
	// loudly, reported, and never stops scheduled moderation.
	let auditHandlesNulled = 0;
	let actionHandlesNulled = 0;
	let handleSweepError: string | null = null;
	if (dryRun) {
		console.info('dry run: commenter-handle retention sweep skipped');
	} else {
		try {
			const nulled = await nullExpiredHandles();
			auditHandlesNulled = nulled.auditLog;
			actionHandlesNulled = nulled.moderationActions;
		} catch (cause) {
			handleSweepError = cause instanceof Error ? cause.message : String(cause);
			console.error('commenter-handle retention sweep failed:', cause);
		}
	}
	const nowIso = new Date().toISOString();
	// Auto top-up sweep: the backstop for orgs whose balance dropped below
	// their threshold without an on-consume trigger (missed trigger, refund,
	// adjustment). Bounded per invocation (I10). Under DRY_RUN nothing is
	// charged — a real money movement is the definition of a durable change.
	let autoTopupsTriggered = 0;
	let autoTopupSweepError: string | null = null;
	if (dryRun) {
		console.info('dry run: auto top-up sweep skipped');
	} else {
		try {
			autoTopupsTriggered = await sweepAutoTopUp(5, deadline);
		} catch (cause) {
			autoTopupSweepError = cause instanceof Error ? cause.message : String(cause);
			console.error('auto top-up sweep failed:', cause);
		}
	}
	// Stripe deletion outbox retry: customers owed erasure from account
	// teardown whose first attempt hit a Stripe outage. Bounded per
	// invocation (I10); a row is removed only after Stripe confirms, so an
	// outage never loses the erasure. DRY_RUN: nothing durable.
	let stripeCustomersDeleted = 0;
	let stripeDeletionSweepError: string | null = null;
	if (dryRun) {
		console.info('dry run: stripe deletion outbox retry skipped');
	} else {
		try {
			stripeCustomersDeleted = await retryStripeCustomerDeletions();
		} catch (cause) {
			stripeDeletionSweepError = cause instanceof Error ? cause.message : String(cause);
			console.error('stripe deletion outbox retry failed:', cause);
		}
	}
	// Stale pending-reversal sweep: refund/dispute obligations whose grant
	// never arrived within 14 days (past Stripe's webhook retry horizon) are
	// dead weight — dropped loudly, bounded per invocation (I10).
	let pendingReversalsDropped = 0;
	let pendingReversalSweepError: string | null = null;
	if (dryRun) {
		console.info('dry run: pending-reversal sweep skipped');
	} else {
		try {
			pendingReversalsDropped = await sweepStalePendingReversals();
		} catch (cause) {
			pendingReversalSweepError = cause instanceof Error ? cause.message : String(cause);
			console.error('pending-reversal sweep failed:', cause);
		}
	}
	const claimable = or(isNull(channels.leaseExpiresAt), lt(channels.leaseExpiresAt, nowIso));
	const [channel] = await db
		.select()
		.from(channels)
		.where(and(eq(channels.active, 1), claimable))
		// Channels with a dry-run drain in flight first — a preview the user is
		// actively waiting on must not starve behind the ordinary rotation.
		.orderBy(desc(sql`${channels.dryRunBoundary} is not null`), asc(channels.lastRunAt))
		.limit(1);
	if (!channel) return json({ ok: true, dryRun, consentEmailsNulled, sweepError, auditHandlesNulled, actionHandlesNulled, handleSweepError, autoTopupsTriggered, autoTopupSweepError, stripeCustomersDeleted, stripeDeletionSweepError, pendingReversalsDropped, pendingReversalSweepError, results: {} });

	// Atomic claim: a concurrent claimant's UPDATE matches 0 rows and exits cleanly.
	const claimed = await db
		.update(channels)
		.set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() })
		.where(and(eq(channels.id, channel.id), claimable))
		.returning({ id: channels.id });
	if (claimed.length === 0)
		return json({ ok: true, claimed: false, dryRun, consentEmailsNulled, sweepError, auditHandlesNulled, actionHandlesNulled, handleSweepError, autoTopupsTriggered, autoTopupSweepError, stripeCustomersDeleted, stripeDeletionSweepError, pendingReversalsDropped, pendingReversalSweepError, results: {} });

	try {
		const result = await runChannel(channel.id, { deadline });
		// Dry-run window drain: one more page per invocation while a preview is
		// in flight (I10 — bounded, same lease). runChannel enforces the shared
		// deadline internally; a partial result leaves the state untouched and
		// the next invocation continues.
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
				// A drain failure must never mask the normal run — loud on the
				// server, surfaced in the payload, retried next invocation.
				console.error('dry-run window drain failed for channel:', channel.id, cause);
				dryRunWindow = { error: cause instanceof Error ? cause.message : String(cause) };
			}
		}
		return json({ ok: true, dryRun, consentEmailsNulled, sweepError, auditHandlesNulled, actionHandlesNulled, handleSweepError, autoTopupsTriggered, autoTopupSweepError, stripeCustomersDeleted, stripeDeletionSweepError, pendingReversalsDropped, pendingReversalSweepError, results: { [channel.id]: result }, dryRunWindow });
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		console.error(`channel run ${channel.id} failed:`, cause);
		return json(
			{ ok: false, dryRun, consentEmailsNulled, sweepError, auditHandlesNulled, actionHandlesNulled, handleSweepError, autoTopupsTriggered, autoTopupSweepError, stripeCustomersDeleted, stripeDeletionSweepError, pendingReversalsDropped, pendingReversalSweepError, results: { [channel.id]: { error: message } } },
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
