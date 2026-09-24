import { isHttpError } from '@sveltejs/kit';

import { banCountsByChannel, commentCountsByChannel } from '$lib/server/channelStats';
import { ownedChannel } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';

/** The channel-detail tabs, derived from the request path so SSR stays prop-driven. */
export type ChannelTab = 'overview' | 'rules' | 'queue' | 'feedback' | 'log';

function tabFromPath(pathname: string): ChannelTab {
	if (pathname.endsWith('/rules')) return 'rules';
	if (pathname.endsWith('/queue')) return 'queue';
	if (pathname.endsWith('/feedback')) return 'feedback';
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
			lastRunStatus: null,
			lastRunError: null,
			lastSuccessAt: null,
			toneLevel: null,
			protectLgbtqia: 0,
			protectWomen: 0,
			active: 1,
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
			lastRunStatus: row.lastRunStatus,
			lastRunError: row.lastRunError,
			lastSuccessAt: row.lastSuccessAt,
			toneLevel: row.toneLevel,
			protectLgbtqia: row.protectLgbtqia,
			protectWomen: row.protectWomen,
			active: row.active,
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
