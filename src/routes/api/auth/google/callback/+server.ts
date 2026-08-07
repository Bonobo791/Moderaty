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

import { redirect, error } from '@sveltejs/kit';

import { parkPendingChannelPick, upsertChannelConnection } from '$lib/server/channelConnect';
import { exchangeGoogleCode } from '$lib/server/google';
import { fetchWithRetry } from '$lib/server/http';
import { readPendingStates, storePendingStates } from '$lib/server/oauthState';
import { requireOrgRole } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';

// Bounds the listing walk so a pathological pageToken loop cannot keep a
// serverless invocation alive. 10 pages × 50 items = 500 channels, far past
// any real account; hitting the bound is logged loudly, not silent.
const MAX_CHANNEL_PAGES = 10;

type ListedChannel = { id: string; title: string };

/**
 * Every channel the authorized Google account owns, across all pages (brand
 * accounts included). I1/I2: each item is validated — a malformed item is
 * skipped and counted loudly; a malformed RESPONSE (non-OK, bad JSON,
 * non-object body) throws 502 and aborts the connect.
 */
async function fetchOwnedChannels(accessToken: string): Promise<ListedChannel[]> {
	const found: ListedChannel[] = [];
	let skipped = 0;
	let pageToken: string | undefined;
	for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
		const endpoint = new URL('https://www.googleapis.com/youtube/v3/channels');
		endpoint.searchParams.set('part', 'snippet');
		endpoint.searchParams.set('mine', 'true');
		endpoint.searchParams.set('maxResults', '50');
		if (pageToken) endpoint.searchParams.set('pageToken', pageToken);

		const chRes = await fetchWithRetry(endpoint.toString(), {
			headers: { Authorization: `Bearer ${accessToken}` }
		});
		const chText = await chRes.text();
		if (!chRes.ok) {
			console.error(`youtube channels lookup failed: ${chRes.status}`);
			throw error(502, 'YouTube channel lookup failed — please retry');
		}
		let chData: { items?: unknown; nextPageToken?: unknown };
		try {
			chData = JSON.parse(chText) as typeof chData;
		} catch {
			console.error(`youtube channels lookup returned invalid JSON: ${chRes.status}`);
			throw error(502, 'invalid response from YouTube — please retry');
		}
		if (typeof chData !== 'object' || chData === null) {
			console.error(`youtube channels lookup returned a non-object body: ${chRes.status}`);
			throw error(502, 'invalid response from YouTube — please retry');
		}

		const items = Array.isArray(chData.items) ? chData.items : [];
		for (const item of items as Array<{ id?: unknown; snippet?: { title?: unknown } }>) {
			if (typeof item?.id === 'string' && item.id) {
				found.push({
					id: item.id,
					title: typeof item.snippet?.title === 'string' ? item.snippet.title : 'Untitled channel'
				});
			} else {
				skipped++;
			}
		}

		pageToken =
			typeof chData.nextPageToken === 'string' && chData.nextPageToken ? chData.nextPageToken : undefined;
		if (!pageToken) return finish(found, skipped);
	}
	console.error(`youtube channels lookup hit the ${MAX_CHANNEL_PAGES}-page bound — listing truncated`);
	return finish(found, skipped);
}

function finish(found: ListedChannel[], skipped: number): ListedChannel[] {
	if (skipped > 0) console.error(`youtube channels lookup skipped ${skipped} malformed item(s)`);
	return found;
}

export async function GET({ url, cookies, locals }: { url: URL; cookies: import('@sveltejs/kit').Cookies; locals: { user: import('$lib/server/session').SessionUser | null } }) {
	// Connecting a channel requires a signed-in account to attach it to — and
	// an admin+ role in the ACTIVE team (members moderate; they don't connect).
	const user = requireUser(locals);
	requireOrgRole(user, 'admin');

	const state = url.searchParams.get('state');
	const pending = readPendingStates(cookies);
	if (!state || !pending.includes(state)) throw error(400, 'bad state');

	const code = url.searchParams.get('code');
	if (!code) throw error(400, 'missing code');

	const tokens = await exchangeGoogleCode(
		code,
		'/api/auth/google/callback',
		'google token exchange',
		'Google token exchange failed — please retry'
	);
	if (!tokens.refreshToken) {
		throw error(
			400,
			'token exchange returned no refresh_token — if this channel was connected before, revoke app access at myaccount.google.com/permissions and retry'
		);
	}

	const owned = await fetchOwnedChannels(tokens.accessToken);
	if (owned.length === 0) {
		throw error(400, 'no YouTube channel found for this Google account');
	}

	// Consume the state only once the flow has succeeded, so a transient
	// failure leaves the callback retryable while a success cannot be replayed.
	storePendingStates(cookies, pending.filter((s) => s !== state));

	if (owned.length > 1) {
		// Several channels (brand accounts): the user picks ONE at the picker.
		// The refresh token is parked — encrypted, state-keyed, 10-minute TTL,
		// bound to the signed-in user who parked it — and never persisted until
		// a channel is chosen.
		parkPendingChannelPick(cookies, state, { refreshToken: tokens.refreshToken, channels: owned }, user.id);
		throw redirect(302, `/connect-channel?state=${encodeURIComponent(state)}`);
	}

	if ((await upsertChannelConnection(user, owned[0], tokens.refreshToken)) === 'conflict') {
		throw error(409, 'this channel is connected to a different Moderaty team');
	}

	throw redirect(302, '/dashboard');
}
