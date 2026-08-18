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

import { isHttpError } from '@sveltejs/kit';

import { banCountsByChannel, commentCountsByChannel } from '$lib/server/channelStats';
import { ownedChannel } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';

/** The channel-detail tabs, derived from the request path so SSR stays prop-driven. */
export type ChannelTab = 'overview' | 'rules' | 'queue' | 'log';

function tabFromPath(pathname: string): ChannelTab {
	if (pathname.endsWith('/rules')) return 'rules';
	if (pathname.endsWith('/queue')) return 'queue';
	if (pathname.endsWith('/log')) return 'log';
	return 'overview';
}

/** Outage payload: no identity, no counts — the layout renders its own error state. */
function maintenancePayload(channelId: string, tab: ChannelTab) {
	return {
		ch: {
			id: channelId,
			title: '',
			lastRunAt: null,
			toneLevel: null,
			protectLgbtqia: 0,
			protectWomen: 0,
			scanning: false
		},
		pending: 0,
		banned: 0,
		tab,
		maintenance: true,
		orgRole: null
	};
}

/**
 * Loads the channel shell: tenancy-gated channel row (404 cross-tenant —
 * never leak existence), the pending-queue count for the Review queue tab
 * label, the ban count for the header Ticker, and the caller's org role for
 * the disconnect danger block on the overview page.
 */
export async function load({ params, locals, url }) {
	const tab = tabFromPath(url.pathname);
	// Database outage: the (app) overlay covers shell-level outages, but a
	// mid-load failure below must degrade the same way instead of 500ing.
	if (locals.dbDown) return maintenancePayload(params.id, tab);
	try {
		const row = await ownedChannel(params.id, locals);
		const user = requireUser(locals);
		const [stats, bans] = await Promise.all([
			commentCountsByChannel([row.id]),
			banCountsByChannel([row.id])
		]);
		const pending = stats.find((s) => s.status === 'pending')?.n ?? 0;
		const banned = bans[0]?.n ?? 0;
		// Project only what the header/tabs/overview render — never serialize
		// refreshTokenEnc (or any future secret column) to the browser. The
		// continuation token is internal drain state; only its presence leaks,
		// as the scanning flag (same contract as the dashboard load).
		const ch = {
			id: row.id,
			title: row.title,
			lastRunAt: row.lastRunAt,
			toneLevel: row.toneLevel,
			protectLgbtqia: row.protectLgbtqia,
			protectWomen: row.protectWomen,
			scanning: row.nextPageToken !== null
		};
		return { ch, pending, banned, tab, maintenance: false, orgRole: user.orgRole };
	} catch (e) {
		// A deliberate HttpError (401 signed out, 404 cross-tenant) is NOT an
		// outage — fail loudly, same as the dashboard load.
		if (isHttpError(e)) throw e;
		console.error('channel layout load failed:', e);
		return maintenancePayload(params.id, tab);
	}
}
