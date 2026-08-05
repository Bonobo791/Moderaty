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
import { deleteUserRecords } from '$lib/server/deletion';
import { revokeGoogleToken } from '$lib/server/google';
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
	if (locals.dbDown) return { chs: [], stats: [], bans: [], maintenance: true };
	const user = requireUser(locals);
	try {
		// Project only the fields the page renders; never serialize refreshTokenEnc
		// (or any future secret column) to the browser. Everything below is scoped
		// to the active team's channels.
		const chs = await db
			.select({
				id: channels.id,
				title: channels.title,
				cursor: channels.cursor,
				lastRunAt: channels.lastRunAt,
				toneLevel: channels.toneLevel,
				protectLgbtqia: channels.protectLgbtqia,
				protectWomen: channels.protectWomen
			})
			.from(channels)
			.where(eq(channels.orgId, user.orgId))
			.all();
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
		return { chs, stats, bans, maintenance: false };
	} catch (e) {
		// A deliberate HttpError is NOT an outage — fail loudly, same as hooks.
		if (isHttpError(e)) throw e;
		// Intermittent outage: the hook queries succeeded but these didn't.
		// Loud on the server, a maintenance overlay for the user — never a 500.
		console.error('dashboard load failed:', e);
		return { chs: [], stats: [], bans: [], maintenance: true };
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
				console.error(`token revocation failed for channel ${ch.id}; deleting anyway:`, cause);
			}
		}
		await deleteUserRecords(user.id);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		throw redirect(302, '/');
	}
};
