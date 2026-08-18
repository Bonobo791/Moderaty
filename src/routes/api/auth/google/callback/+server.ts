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

import { redirect, error } from '@sveltejs/kit';

import {
	decodeChannelState,
	parkPendingChannelPick,
	upsertChannelConnection
} from '$lib/server/channelConnect';
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
	// The channel-connect state is SELF-AUTHENTICATING: its AES-GCM ciphertext
	// embeds the starter's userId, so the starter is derived from the state
	// itself. Two consequences:
	//  1. The binding is unforgeable (no ENCRYPTION_KEY) — a hand-crafted or
	//     tampered state fails to decode and is rejected below.
	//  2. A concurrent-start lost-update of the shared oauth_state cookie can
	//     no longer invalidate a valid flow: the state's own signature is the
	//     authority, the cookie entry is only the CSRF layer. A state that
	//     decodes correctly is accepted even if its cookie entry was dropped.
	const startedBy = state ? decodeChannelState(state) : null;
	if (!state || (!pending.includes(state) && !startedBy)) throw error(400, 'bad state');

	// The state must have been STARTED by this user: a flow begun on a shared
	// machine by someone else must never exchange its authorization code under
	// this session — that would park (or connect) the starter's grant here
	// (CodeRabbit 3738037981). A login-flow state (never bound) is rejected
	// too, before any Google call.
	if (!startedBy || startedBy.userId !== user.id) {
		throw error(400, 'this connection was started by a different account — sign out and start again from the dashboard');
	}

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

	// State consumption runs ONLY after the persistence below has succeeded,
	// so a transient post-exchange failure (a throwing picker write or upsert)
	// leaves the state in place. Note the boundary this is honest about: the
	// authorization CODE is single-use, so a post-exchange failure still needs
	// a fresh flow — only a PRE-exchange failure is retryable with this state.
	const consumeState = () => {
		storePendingStates(cookies, pending.filter((s) => s !== state));
	};

	if (owned.length > 1) {
		// Several channels (brand accounts): the user picks ONE at the picker.
		// The refresh token is parked — encrypted, state-keyed, 10-minute TTL,
		// bound to the signed-in user who parked it — and never persisted until
		// a channel is chosen.
		parkPendingChannelPick(cookies, state, { refreshToken: tokens.refreshToken, channels: owned }, user.id);
		consumeState();
		throw redirect(302, `/connect-channel?state=${encodeURIComponent(state)}`);
	}

	if ((await upsertChannelConnection(user, owned[0], tokens.refreshToken)) === 'conflict') {
		consumeState();
		throw error(409, 'this channel is connected to a different Moderaty team');
	}
	consumeState();

	throw redirect(302, '/dashboard');
}
