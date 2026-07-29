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

import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { encrypt } from '$lib/server/crypto';
import { fetchWithRetry } from '$lib/server/http';
import { readPendingStates, storePendingStates } from '$lib/server/oauthState';

export async function GET({ url, cookies }: { url: URL; cookies: import('@sveltejs/kit').Cookies }) {
	const state = url.searchParams.get('state');
	const pending = readPendingStates(cookies);
	if (!state || !pending.includes(state)) throw error(400, 'bad state');
	storePendingStates(cookies, pending.filter((s) => s !== state));

	const code = url.searchParams.get('code');
	if (!code) throw error(400, 'missing code');

	if (!env.GOOGLE_CLIENT_ID) throw error(500, 'GOOGLE_CLIENT_ID is not configured');
	if (!env.GOOGLE_CLIENT_SECRET) throw error(500, 'GOOGLE_CLIENT_SECRET is not configured');
	if (!env.APP_URL) throw error(500, 'APP_URL is not configured');

	// Failures are logged server-side with redacted detail; the client only ever
	// sees the generic messages below — never tokens (AGENTS.md).
	// The authorization code is one-time use, so this exchange must not retry:
	// a retried request after a transient timeout would fail the sign-in.
	const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			redirect_uri: new URL('/api/auth/google/callback', env.APP_URL).toString(),
			grant_type: 'authorization_code'
		})
	});
	const tokenText = await tokenRes.text();
	let tokens: {
		refresh_token?: unknown;
		access_token?: unknown;
		error?: unknown;
		error_description?: unknown;
	};
	try {
		tokens = JSON.parse(tokenText) as typeof tokens;
	} catch {
		console.error(`google token exchange returned invalid JSON: ${tokenRes.status}`);
		throw error(502, 'invalid response from Google — please retry');
	}
	if (!tokenRes.ok) {
		// Upstream failure, not a user error. Log only status and Google's
		// non-secret error fields — never the raw body, which may carry tokens.
		const detail =
			typeof tokens.error === 'string'
				? `${tokens.error}${typeof tokens.error_description === 'string' ? `: ${tokens.error_description}` : ''}`
				: 'no error detail';
		console.error(`google token exchange failed: ${tokenRes.status} ${detail}`);
		throw error(502, 'Google token exchange failed — please retry');
	}
	if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
		throw error(
			400,
			'token exchange returned no refresh_token — if this channel was connected before, revoke app access at myaccount.google.com/permissions and retry'
		);
	}
	if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
		console.error('google token exchange returned 200 without an access_token');
		throw error(502, 'invalid response from Google — please retry');
	}

	const chRes = await fetchWithRetry(
		'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
		{ headers: { Authorization: `Bearer ${tokens.access_token}` } }
	);
	const chText = await chRes.text();
	if (!chRes.ok) {
		console.error(`youtube channels lookup failed: ${chRes.status} ${chText}`);
		throw error(502, 'YouTube channel lookup failed — please retry');
	}
	let chData: { items?: Array<{ id?: unknown; snippet?: { title?: unknown } }> };
	try {
		chData = JSON.parse(chText) as typeof chData;
	} catch {
		console.error(`youtube channels lookup returned invalid JSON: ${chText}`);
		throw error(502, 'invalid response from YouTube — please retry');
	}

	const ch = Array.isArray(chData.items) ? chData.items[0] : undefined;
	if (typeof ch?.id !== 'string' || !ch.id) {
		throw error(400, 'no YouTube channel found for this Google account');
	}
	const title = typeof ch.snippet?.title === 'string' ? ch.snippet.title : 'Untitled channel';

	await db
		.insert(channels)
		.values({
			id: ch.id,
			title,
			refreshTokenEnc: encrypt(tokens.refresh_token),
			active: 1,
			createdAt: new Date().toISOString()
		})
		.onConflictDoUpdate({
			target: channels.id,
			set: { title, refreshTokenEnc: encrypt(tokens.refresh_token), active: 1 }
		});

	throw redirect(302, '/');
}
