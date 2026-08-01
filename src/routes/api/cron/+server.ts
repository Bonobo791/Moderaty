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
import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { auditLog, channels, comments, moderationActions, rules, sessions, users } from '$lib/server/db/schema';
import { runChannel } from '$lib/server/pipeline';
import type { RequestHandler } from './$types';

const LEASE_MS = 10 * 60 * 1000; // exceeds one bounded run; expiry alone re-eligibilizes after a crash
const RUN_BUDGET_MS = 20 * 1000; // below the scheduled trigger's 25s abort, so the server stops first
const RETENTION_MS = 180 * 24 * 60 * 60 * 1000; // deleted accounts are purged after 6 months

/** Constant-time secret comparison; never throws on length mismatch. */
function secretMatches(provided: string | null, expected: string): boolean {
	if (!provided) return false;
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Permanently purges ONE user whose 6-month retention expired (I10: the rest
 * drain across invocations). Everything the user owned goes — sessions,
 * channels and their rules/comments/moderation actions/audit rows — EXCEPT
 * the evidentiary consent log (LGPD Art. 16 legal-defense retention): the
 * users row is anonymized to a tombstone so consents.userId stays valid and
 * the real Google sub is freed for a future fresh signup.
 */
async function purgeExpiredUser(): Promise<string | null> {
	const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
	const expired = await db
		.select({ id: users.id })
		.from(users)
		.where(and(isNotNull(users.deletedAt), lt(users.deletedAt, cutoff)))
		.orderBy(asc(users.deletedAt))
		.limit(1)
		.get();
	if (!expired) return null;
	await db.transaction(async (tx) => {
		const chs = await tx.select({ id: channels.id }).from(channels).where(eq(channels.userId, expired.id)).all();
		const channelIds = chs.map((ch) => ch.id);
		if (channelIds.length > 0) {
			await tx.delete(moderationActions).where(inArray(moderationActions.channelId, channelIds));
			await tx.delete(comments).where(inArray(comments.channelId, channelIds));
			await tx.delete(auditLog).where(inArray(auditLog.channelId, channelIds));
			await tx.delete(rules).where(inArray(rules.channelId, channelIds));
			await tx.delete(channels).where(eq(channels.userId, expired.id));
		}
		await tx.delete(sessions).where(eq(sessions.userId, expired.id));
		await tx
			.update(users)
			.set({ googleSub: `deleted:${expired.id}`, email: '[deleted]', displayName: '[deleted]' })
			.where(eq(users.id, expired.id));
	});
	return expired.id;
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
	// Retention purge runs first, while the full budget remains. I8: a dry run
	// changes nothing durable — the would-be purge is only logged.
	let purged: string | null = null;
	if (dryRun) {
		console.info('dry run: retention purge skipped');
	} else {
		purged = await purgeExpiredUser();
	}
	const nowIso = new Date().toISOString();
	const claimable = or(isNull(channels.leaseExpiresAt), lt(channels.leaseExpiresAt, nowIso));
	const [channel] = await db
		.select()
		.from(channels)
		.where(and(eq(channels.active, 1), claimable))
		.orderBy(asc(channels.lastRunAt))
		.limit(1);
	if (!channel) return json({ ok: true, dryRun, purged, results: {} });

	// Atomic claim: a concurrent claimant's UPDATE matches 0 rows and exits cleanly.
	const claimed = await db
		.update(channels)
		.set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() })
		.where(and(eq(channels.id, channel.id), claimable))
		.returning({ id: channels.id });
	if (claimed.length === 0) return json({ ok: true, claimed: false, dryRun, purged, results: {} });

	try {
		const result = await runChannel(channel.id, { deadline });
		return json({ ok: true, dryRun, purged, results: { [channel.id]: result } });
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		console.error(`channel run ${channel.id} failed:`, cause);
		return json(
			{ ok: false, dryRun, purged, results: { [channel.id]: { error: message } } },
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
