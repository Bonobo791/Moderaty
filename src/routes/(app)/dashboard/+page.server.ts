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

import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { banCountsByChannel, commentCountsByChannel } from '$lib/server/channelStats';
import { requireUser } from '$lib/server/session';
import { eq } from 'drizzle-orm';
import { isHttpError } from '@sveltejs/kit';

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
