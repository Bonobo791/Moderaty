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

import { eq, isNull, or } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { encrypt } from '$lib/server/crypto';
import { exchangeGoogleCode } from '$lib/server/google';
import { fetchWithRetry } from '$lib/server/http';
import { readPendingStates, storePendingStates } from '$lib/server/oauthState';
import { requireUser } from '$lib/server/session';

export async function GET({ url, cookies, locals }: { url: URL; cookies: import('@sveltejs/kit').Cookies; locals: { user: import('$lib/server/session').SessionUser | null } }) {
	// Connecting a channel requires a signed-in account to attach it to.
	const user = requireUser(locals);

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

	const chRes = await fetchWithRetry(
		'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
		{ headers: { Authorization: `Bearer ${tokens.accessToken}` } }
	);
	const chText = await chRes.text();
	if (!chRes.ok) {
		console.error(`youtube channels lookup failed: ${chRes.status}`);
		throw error(502, 'YouTube channel lookup failed — please retry');
	}
	let chData: { items?: Array<{ id?: unknown; snippet?: { title?: unknown } }> };
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

	const ch = Array.isArray(chData.items) ? chData.items[0] : undefined;
	if (typeof ch?.id !== 'string' || !ch.id) {
		throw error(400, 'no YouTube channel found for this Google account');
	}
	const title = typeof ch.snippet?.title === 'string' ? ch.snippet.title : 'Untitled channel';

	// A channel already owned by another account must not be reattached (or have
	// its refresh token overwritten) by this one. The conditional upsert keeps
	// that check atomic with the write — a SELECT-then-upsert would race.
	const refreshTokenEnc = encrypt(tokens.refreshToken);
	const updated = await db
		.insert(channels)
		.values({
			id: ch.id,
			userId: user.id,
			title,
			refreshTokenEnc,
			active: 1,
			createdAt: new Date().toISOString()
		})
		.onConflictDoUpdate({
			target: channels.id,
			set: { userId: user.id, title, refreshTokenEnc, active: 1 },
			setWhere: or(isNull(channels.userId), eq(channels.userId, user.id))
		})
		.returning({ id: channels.id });
	if (updated.length === 0) {
		throw error(409, 'this channel is connected to a different Moderaty account');
	}

	// Consume the state only once the flow has succeeded, so a transient
	// failure leaves the callback retryable while a success cannot be replayed.
	storePendingStates(cookies, pending.filter((s) => s !== state));

	throw redirect(302, '/dashboard');
}
