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
import { channels } from '$lib/server/db/schema';
import { banCountsByChannel, commentCountsByChannel } from '$lib/server/channelStats';
import { decrypt } from '$lib/server/crypto';
import { deleteUserRecords } from '$lib/server/deletion';
import { revokeGoogleToken } from '$lib/server/google';
import { requireUser, SESSION_COOKIE } from '$lib/server/session';
import { eq } from 'drizzle-orm';
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
		const stats = await commentCountsByChannel(channelIds);
		const bans = await banCountsByChannel(channelIds);
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

export const actions = {
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
	}
};
