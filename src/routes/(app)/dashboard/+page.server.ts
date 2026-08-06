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

import { db } from '$lib/server/db';
import { auditLog, channels, comments } from '$lib/server/db/schema';
import { decrypt } from '$lib/server/crypto';
import { deleteChannelRecords, deleteUserRecords } from '$lib/server/deletion';
import { revokeGoogleToken } from '$lib/server/google';
import { requireOrgRole } from '$lib/server/ownership';
import { runChannel } from '$lib/server/pipeline';
import { requireUser, SESSION_COOKIE } from '$lib/server/session';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { fail, isHttpError, redirect } from '@sveltejs/kit';

/**
 * Loads the authenticated user's channels and moderation statistics for the dashboard.
 *
 * @returns The user's channels, comment counts grouped by channel and status, and completed ban counts grouped by channel.
 */
export async function load({ locals }) {
	// Database outage: the overlay replaces the dashboard. Checked before
	// requireUser because an outage means the session lookup failed and
	// locals.user is null — the maintenance page IS the signed-in state.
	if (locals.dbDown) return { chs: [], stats: [], bans: [], maintenance: true, orgRole: null };
	const user = requireUser(locals);
	try {
		// Project only the fields the page renders; never serialize refreshTokenEnc
		// (or any future secret column) to the browser. Everything below is scoped
		// to the active team's channels.
		const rows = await db
			.select({
				id: channels.id,
				title: channels.title,
				cursor: channels.cursor,
				lastRunAt: channels.lastRunAt,
				toneLevel: channels.toneLevel,
				protectLgbtqia: channels.protectLgbtqia,
				protectWomen: channels.protectWomen,
				nextPageToken: channels.nextPageToken
			})
			.from(channels)
			.where(eq(channels.orgId, user.orgId))
			.all();
		// A non-null continuation token means a history drain is in flight (the
		// pipeline clears it on completion) — flag it so the dashboard can keep
		// the "scan in progress" status up across refreshes. The token itself is
		// internal drain state and is never sent to the browser.
		const chs = rows.map(({ nextPageToken, ...ch }) => ({ ...ch, scanning: nextPageToken !== null }));
		const channelIds = chs.map((ch) => ch.id);
		const stats = channelIds.length
			? await db
					.select({ channelId: comments.channelId, status: comments.status, n: sql<number>`count(*)` })
					.from(comments)
					.where(inArray(comments.channelId, channelIds))
					.groupBy(comments.channelId, comments.status)
					.all()
			: [];
		// Count ban EVENTS from the audit log, not moderation_actions: manual queue
		// bans never create moderation_actions rows, so counting that table hid
		// every user-taken ban. Both ban paths write exactly one audit row per ban
		// (pipeline: completeActions, same transaction as the completed update;
		// manual: the queue action itself). Bans are irreversible, so ban events
		// equal ban state; dry-run rows are excluded by the action filter.
		const bans = channelIds.length
			? await db
					.select({ channelId: auditLog.channelId, n: sql<number>`count(*)` })
					.from(auditLog)
					.where(and(eq(auditLog.action, 'ban'), inArray(auditLog.channelId, channelIds)))
					.groupBy(auditLog.channelId)
					.all()
			: [];
		return { chs, stats, bans, maintenance: false, orgRole: user.orgRole };
	} catch (e) {
		// A deliberate HttpError is NOT an outage — fail loudly, same as hooks.
		if (isHttpError(e)) throw e;
		// Intermittent outage: the hook queries succeeded but these didn't.
		// Loud on the server, a maintenance overlay for the user — never a 500.
		console.error('dashboard load failed:', e);
		return { chs: [], stats: [], bans: [], maintenance: true, orgRole: null };
	}
}

/**
 * Tenancy-scoped channel update shared by the card actions: another team's
 * channel reads as "not found" (zero rows updated, never a leak).
 */
async function updateOwnChannel(
	orgId: string,
	channelId: string,
	values: Partial<Pick<typeof channels.$inferInsert, 'toneLevel' | 'protectLgbtqia' | 'protectWomen'>>
) {
	return db
		.update(channels)
		.set(values)
		.where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)))
		.returning({ id: channels.id });
}

export const actions = {
	setToneLevel: async ({ request, locals }) => {
		const user = requireUser(locals);
		const f = await request.formData();
		const channelId = String(f.get('channelId') ?? '');
		const toneLevel = Number(f.get('toneLevel'));
		if (toneLevel !== 1 && toneLevel !== 2) {
			return fail(400, { error: 'tone level must be 1 (Edge Lord) or 2 (Edge lord + Ackchyually…)' });
		}
		const updated = await updateOwnChannel(user.orgId, channelId, { toneLevel });
		if (updated.length === 0) return fail(404, { error: 'channel not found' });
		return { ok: true };
	},
	setProtections: async ({ request, locals }) => {
		const user = requireUser(locals);
		const f = await request.formData();
		const channelId = String(f.get('channelId') ?? '');
		// Checkbox semantics: 'on' when ticked, absent when not — an absent
		// field persists 0 so unticking clears the flag.
		const protectLgbtqia = f.get('protectLgbtqia') === 'on' ? 1 : 0;
		const protectWomen = f.get('protectWomen') === 'on' ? 1 : 0;
		const updated = await updateOwnChannel(user.orgId, channelId, { protectLgbtqia, protectWomen });
		if (updated.length === 0) return fail(404, { scope: 'protections', channelId, error: 'channel not found' });
		return { ok: true };
	},
	analyzeHistory: async ({ request, locals }) => {
		const user = requireUser(locals);
		const f = await request.formData();
		const channelId = String(f.get('channelId') ?? '');
		const months = Number(f.get('months'));
		// Preset windows only — the scan drains newest-first at 300 comments per
		// run, so an unbounded window is an unbounded API/AI cost (I10).
		if (![1, 3, 6, 12, 24].includes(months)) {
			return fail(400, { scope: 'history', channelId, error: 'history window must be 1, 3, 6, 12, or 24 months' });
		}
		// Move the scan boundary back and reset the drain state: cron's next runs
		// page from the newest comment down to this boundary. Already-seen
		// comments are skipped before scoring (decideNewComments dedupes by id),
		// so only the unscanned history costs moderation calls. Tenancy-scoped:
		// another team's channel reads as "not found".
		const boundary = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000).toISOString();
		// Coordinate with the cron lease: a run in flight would otherwise persist
		// its own scan state and silently cancel (or be cancelled by) this reset.
		// The lease predicate is part of the UPDATE itself, so the check is
		// atomic with the write (mirrors the claim predicate in api/cron).
		const claimable = or(isNull(channels.leaseExpiresAt), lt(channels.leaseExpiresAt, new Date().toISOString()));
		const updated = await db
			.update(channels)
			.set({ cursor: boundary, nextPageToken: null, scanCursor: null })
			.where(and(eq(channels.id, channelId), eq(channels.orgId, user.orgId), claimable))
			.returning({ id: channels.id });
		if (updated.length === 0) {
			// Distinguish "not your channel" from "currently scanning": the extra
			// read only happens on the failure path.
			const existing = await db
				.select({ id: channels.id })
				.from(channels)
				.where(and(eq(channels.id, channelId), eq(channels.orgId, user.orgId)))
				.get();
			if (existing) {
				return fail(409, {
					scope: 'history',
					channelId,
					error: 'This channel is mid-scan — retry in a minute.'
				});
			}
			return fail(404, { scope: 'history', channelId, error: 'channel not found' });
		}
		console.info(`history analysis requested for channel ${channelId}: scanning back to ${boundary}`);
		return { ok: true, scope: 'history', channelId, months };
	},
	dryRun: async ({ request, locals }) => {
		const user = requireUser(locals);
		const f = await request.formData();
		const channelId = String(f.get('channelId') ?? '');
		// Same presets as Analyze history; absent → 3 (the UI default). 'all'
		// covers channels whose entire history predates every months preset.
		const rawMonths = f.has('months') ? String(f.get('months')) : '3';
		if (rawMonths !== 'all' && ![1, 3, 6, 12, 24].includes(Number(rawMonths))) {
			return fail(400, { scope: 'dryRun', channelId, error: 'dry-run window must be 1, 3, 6, 12, or 24 months, or all time' });
		}
		const months = rawMonths === 'all' ? ('all' as const) : Number(rawMonths);
		// 'all' maps to the epoch boundary: no comment is ever older than it, and
		// the non-null drain state keeps cron paging until YouTube runs out of pages.
		const boundary =
			months === 'all'
				? '1970-01-01T00:00:00.000Z'
				: new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000).toISOString();
		// Atomic lease claim, same protocol as cron/analyzeHistory: the UPDATE's
		// predicate makes concurrent claimants single-winner (TOCTOU-safe), and
		// it doubles as the tenancy check — another team's channel matches 0
		// rows and reads as "not found". The lease self-expires if this request
		// dies mid-preview.
		const myLease = new Date(Date.now() + 60_000).toISOString();
		const claimable = or(isNull(channels.leaseExpiresAt), lt(channels.leaseExpiresAt, new Date().toISOString()));
		const claimed = await db
			.update(channels)
			.set({ leaseExpiresAt: myLease })
			.where(and(eq(channels.id, channelId), eq(channels.orgId, user.orgId), claimable))
			.returning({ id: channels.id });
		if (claimed.length === 0) {
			// Distinguish "not your channel" from "currently scanning": the extra
			// read only happens on the failure path.
			const existing = await db
				.select({ id: channels.id })
				.from(channels)
				.where(and(eq(channels.id, channelId), eq(channels.orgId, user.orgId)))
				.get();
			if (existing) {
				return fail(409, { scope: 'dryRun', channelId, error: 'This channel is mid-scan — retry in a minute.' });
			}
			return fail(404, { scope: 'dryRun', channelId, error: 'channel not found' });
		}
		// First page synchronously (one page, hard 20 s ceiling); a window with
		// more pages drains one page per cron invocation afterwards. The run
		// writes nothing durable except dry-run audit rows (I8).
		try {
			const result = await runChannel(channelId, {
				deadline: Date.now() + 20_000,
				forceDryRun: true,
				window: { boundary, pageToken: null }
			});
			// Persist the drain state under the held lease: incomplete windows
			// hand cron the continuation; complete ones clear any older drain.
			// A deadline-partial result has no continuation token, but leaving an
			// OLD drain in place would keep cron draining the window the user
			// just abandoned — so any non-skipped, non-complete result restarts
			// the NEW window from the top in the background. A skipped run
			// (channel paused) touches nothing.
			const background = !result.skipped && result.windowComplete !== true;
			if (result.windowComplete === true) {
				await db
					.update(channels)
					.set({ dryRunBoundary: null, dryRunPageToken: null })
					.where(eq(channels.id, channelId));
			} else if (!result.skipped) {
				await db
					.update(channels)
					.set({ dryRunBoundary: boundary, dryRunPageToken: result.windowNextPageToken ?? null })
					.where(eq(channels.id, channelId));
			}
			return { ok: true as const, scope: 'dryRun', channelId, months, ...result, background };
		} catch (e) {
			// Loud server-side, generic client-side — never return raw
			// YouTube/OpenAI error detail to the browser.
			console.error('dry run failed for channel:', channelId, e);
			return fail(502, { scope: 'dryRun', channelId, error: 'The dry run failed — check the server log and try again.' });
		} finally {
			// Release only OUR lease: if the preview overran it and cron claimed
			// the channel in between, that lease is untouched. lastRunAt is
			// deliberately not set — a preview is not a run.
			await db
				.update(channels)
				.set({ leaseExpiresAt: null })
				.where(and(eq(channels.id, channelId), eq(channels.leaseExpiresAt, myLease)));
		}
	},
	deleteAccount: async ({ request, locals, cookies }) => {
		const user = requireUser(locals);
		const f = await request.formData();
		if (f.get('confirm') !== 'on') {
			return fail(400, { error: 'You must confirm account deletion to continue.' });
		}
		// Immediate deletion: everything is erased NOW except the evidentiary
		// consent log (statutory retention, LGPD Art. 16, III). Each channel's
		// YouTube grant is revoked at Google first (YouTube API ToS); a
		// revocation failure is logged loudly but does not block deletion — the
		// encrypted token is erased either way, orphaning the grant.
		// Revocation is connector-scoped (channels.userId = the account being
		// deleted): those Google grants belong to THIS user. Channels in teams
		// that survive the deletion keep their rows; their dead token will fail
		// loudly in cron until a teammate reconnects the channel.
		const owned = await db
			.select({ id: channels.id, refreshTokenEnc: channels.refreshTokenEnc })
			.from(channels)
			.where(eq(channels.userId, user.id))
			.all();
		for (const ch of owned) {
			try {
				await revokeGoogleToken(decrypt(ch.refreshTokenEnc), `account deletion channel ${ch.id}`);
			} catch (cause) {
				console.error('token revocation failed for channel, deleting anyway:', ch.id, cause);
			}
		}
		await deleteUserRecords(user.id);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		throw redirect(302, '/');
	},
	disconnectChannel: async ({ request, locals }) => {
		const user = requireUser(locals);
		// Same gate as connecting a channel: members moderate, admins manage.
		requireOrgRole(user, 'admin');
		const f = await request.formData();
		const channelId = String(f.get('channelId') ?? '');
		if (f.get('confirm') !== 'on') {
			return fail(400, { scope: 'disconnect', channelId, error: 'You must confirm the disconnect to continue.' });
		}
		// Tenancy check doubles as the existence check: another team's channel
		// matches 0 rows and reads as "not found" — never leak existence.
		const channel = await db
			.select({ id: channels.id, refreshTokenEnc: channels.refreshTokenEnc })
			.from(channels)
			.where(and(eq(channels.id, channelId), eq(channels.orgId, user.orgId)))
			.get();
		if (!channel) {
			return fail(404, { scope: 'disconnect', channelId, error: 'channel not found' });
		}
		// Best-effort revoke BEFORE the erase (YouTube API ToS); a failure —
		// including a grant minted by another environment's OAuth client, or an
		// already-wiped token — is logged loudly but never blocks, since the
		// ciphertext dies either way.
		try {
			await revokeGoogleToken(decrypt(channel.refreshTokenEnc), `channel disconnect ${channel.id}`);
		} catch (cause) {
			console.error('token revocation failed for channel, disconnecting anyway:', channel.id, cause);
		}
		await db.transaction(async (tx) => {
			await deleteChannelRecords(tx, [channel.id], { expectedOrgId: user.orgId });
		});
		// The channel's own audit rows die with it — the server log is the record.
		console.info(`channel ${channel.id} disconnected and erased by user ${user.id}`);
		return { ok: true as const, scope: 'disconnect', channelId };
	}
};
