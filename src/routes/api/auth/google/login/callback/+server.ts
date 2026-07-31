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

import { randomBytes } from 'node:crypto';

import { isNull, eq } from 'drizzle-orm';

import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels, users } from '$lib/server/db/schema';
import { readPendingStates, storePendingStates } from '$lib/server/oauthState';
import { createSession, SESSION_COOKIE } from '$lib/server/session';

export async function GET({ url, cookies }: { url: URL; cookies: import('@sveltejs/kit').Cookies }) {
	const state = url.searchParams.get('state');
	const pending = readPendingStates(cookies);
	if (!state || !pending.includes(state)) throw error(400, 'bad state');

	const code = url.searchParams.get('code');
	if (!code) throw error(400, 'missing code');

	if (!env.GOOGLE_CLIENT_ID) throw error(500, 'GOOGLE_CLIENT_ID is not configured');
	if (!env.GOOGLE_CLIENT_SECRET) throw error(500, 'GOOGLE_CLIENT_SECRET is not configured');
	if (!env.APP_URL) throw error(500, 'APP_URL is not configured');

	// Failures are logged server-side with redacted detail; the client only ever
	// sees the generic messages below — never tokens (AGENTS.md).
	// The authorization code is one-time use, so this exchange must not retry:
	// a retried request after a transient timeout would fail the sign-in.
	let tokenRes: Response;
	let tokenText: string;
	try {
		tokenRes = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				code,
				client_id: env.GOOGLE_CLIENT_ID,
				client_secret: env.GOOGLE_CLIENT_SECRET,
				redirect_uri: new URL('/api/auth/google/login/callback', env.APP_URL).toString(),
				grant_type: 'authorization_code'
			}),
			signal: AbortSignal.timeout(10_000)
		});
		tokenText = await tokenRes.text();
	} catch (e) {
		console.error(`google login token exchange request failed: ${e instanceof Error ? e.message : e}`);
		throw error(502, 'Google sign-in failed — please retry');
	}
	let tokens: { access_token?: unknown; error?: unknown; error_description?: unknown };
	try {
		tokens = JSON.parse(tokenText) as typeof tokens;
	} catch {
		console.error(`google login token exchange returned invalid JSON: ${tokenRes.status}`);
		throw error(502, 'invalid response from Google — please retry');
	}
	if (typeof tokens !== 'object' || tokens === null) {
		console.error(`google login token exchange returned a non-object body: ${tokenRes.status}`);
		throw error(502, 'invalid response from Google — please retry');
	}
	if (!tokenRes.ok) {
		// Upstream failure, not a user error. Log only status and Google's
		// non-secret error fields — never the raw body, which may carry tokens.
		const detail =
			typeof tokens.error === 'string'
				? `${tokens.error}${typeof tokens.error_description === 'string' ? `: ${tokens.error_description}` : ''}`
				: 'no error detail';
		console.error(`google login token exchange failed: ${tokenRes.status} ${detail}`);
		throw error(502, 'Google sign-in failed — please retry');
	}
	if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
		console.error('google login token exchange returned 200 without an access_token');
		throw error(502, 'invalid response from Google — please retry');
	}

	const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
		headers: { Authorization: `Bearer ${tokens.access_token}` },
		signal: AbortSignal.timeout(10_000)
	});
	const infoText = await infoRes.text();
	if (!infoRes.ok) {
		console.error(`google userinfo lookup failed: ${infoRes.status}`);
		throw error(502, 'Google sign-in failed — please retry');
	}
	let info: { sub?: unknown; email?: unknown; name?: unknown };
	try {
		info = JSON.parse(infoText) as typeof info;
	} catch {
		console.error(`google userinfo returned invalid JSON: ${infoRes.status}`);
		throw error(502, 'invalid response from Google — please retry');
	}
	// I2: identity claims are validated at the boundary; no sub, no sign-in.
	if (typeof info !== 'object' || info === null || typeof info.sub !== 'string' || !info.sub) {
		console.error('google userinfo returned no usable sub claim');
		throw error(502, 'invalid response from Google — please retry');
	}
	const email = typeof info.email === 'string' && info.email ? info.email : `${info.sub}@accounts.google.com`;
	const displayName = typeof info.name === 'string' && info.name ? info.name : email;

	// Find-or-create the account by Google's stable sub claim.
	let user = await db.select().from(users).where(eq(users.googleSub, info.sub)).get();
	if (!user) {
		user = await db
			.insert(users)
			.values({ id: randomBytes(16).toString('hex'), googleSub: info.sub, email, displayName })
			.returning()
			.get();
		// First login ever on a pre-accounts database claims the orphaned
		// (ownerless) channels. A fresh multi-user deploy has no orphans.
		await db.update(channels).set({ userId: user.id }).where(isNull(channels.userId));
	}

	const { token, expiresAt } = await createSession(user.id);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		expires: new Date(expiresAt)
	});

	// Consume the state only once the flow has succeeded, so a transient
	// failure leaves the callback retryable while a success cannot be replayed.
	storePendingStates(cookies, pending.filter((s) => s !== state));

	throw redirect(302, '/dashboard');
}
