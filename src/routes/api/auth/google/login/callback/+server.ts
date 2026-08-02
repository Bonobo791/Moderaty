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

import { and, eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { consents, users } from '$lib/server/db/schema';
import { exchangeGoogleCode } from '$lib/server/google';
import { LEGAL_VERSION, parkPendingConsent } from '$lib/server/legal';
import { cookieSecure, readPendingStates, storePendingStates } from '$lib/server/oauthState';
import { isRetentionExpired, purgeUserById } from '$lib/server/retention';
import { createSession, SESSION_COOKIE } from '$lib/server/session';

/**
 * Handles the Google OAuth login callback, completing authentication or redirecting the user to consent.
 *
 * @param url - The callback URL containing the OAuth state and authorization code
 * @param cookies - The request cookies used to validate OAuth state and manage authentication data
 */
export async function GET({ url, cookies }: { url: URL; cookies: import('@sveltejs/kit').Cookies }) {
	const state = url.searchParams.get('state');
	const pending = readPendingStates(cookies);
	if (!state || !pending.includes(state)) throw error(400, 'bad state');

	const code = url.searchParams.get('code');
	if (!code) throw error(400, 'missing code');

	const tokens = await exchangeGoogleCode(
		code,
		'/api/auth/google/login/callback',
		'google login token exchange',
		'Google sign-in failed — please retry'
	);

	let infoRes: Response;
	let infoText: string;
	try {
		infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
			signal: AbortSignal.timeout(10_000)
		});
		infoText = await infoRes.text();
	} catch (e) {
		console.error(`google userinfo request failed: ${e instanceof Error ? e.message : e}`);
		throw error(502, 'Google sign-in failed — please retry');
	}
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
	const sub: string = info.sub;

	// The contract forms at the /consent checkbox, not here. A NEW identity is
	// parked in an encrypted pending cookie — no account and no session exist
	// before acceptance. An existing account skips the interstitial only when
	// its latest consent covers the current LEGAL_VERSION; a stale or missing
	// consent sends it back through /consent (re-acceptance on doc updates).
	let user = await db.select().from(users).where(eq(users.googleSub, sub)).get();
	// Past the retention window the account is already due for purge — remove
	// it now (freeing the Google sub) and let the flow continue as a fresh
	// signup. Restoring it here would defeat the documented 6-month purge.
	if (user?.deletedAt && isRetentionExpired(user.deletedAt)) {
		console.info(`account ${user.id} past the retention window; purging at sign-in`);
		await purgeUserById(user.id);
		user = undefined;
	}
	if (!user) {
		parkPendingConsent(cookies, state, { kind: 'new', sub, email, displayName });
		storePendingStates(cookies, pending.filter((s) => s !== state));
		throw redirect(302, `/consent?state=${encodeURIComponent(state)}`);
	}
	// A pending deletion is NOT cancelled here: if the account's consent is
	// stale or missing it is parked for /consent with deletedAt still set, so
	// abandoning the interstitial leaves the retention purge intact. The
	// restore happens only once the sign-in actually completes (below, or at
	// consent acceptance).
	const consent = await db
		.select({ id: consents.id })
		.from(consents)
		.where(and(eq(consents.userId, user.id), eq(consents.docVersion, LEGAL_VERSION)))
		.get();
	if (!consent) {
		parkPendingConsent(cookies, state, { kind: 'existing', userId: user.id });
		storePendingStates(cookies, pending.filter((s) => s !== state));
		throw redirect(302, `/consent?state=${encodeURIComponent(state)}`);
	}

	// Signing back in WITHIN the 6-month retention window cancels a pending
	// deletion — only now that the sign-in completes. Channels stay inactive
	// (active=0 from the deletion) until the user re-enables them — moderation
	// never resumes silently. (Accounts past the window never reach here —
	// they are purged inline above.)
	if (user.deletedAt) {
		await db.update(users).set({ deletedAt: null }).where(eq(users.id, user.id));
		console.info(`account ${user.id} restored by sign-in; pending deletion cancelled`);
	}

	const { token, expiresAt } = await createSession(user.id);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: cookieSecure(),
		expires: new Date(expiresAt)
	});

	// Consume the state only once the flow has succeeded, so a transient
	// failure leaves the callback retryable while a success cannot be replayed.
	storePendingStates(cookies, pending.filter((s) => s !== state));

	throw redirect(302, '/dashboard');
}
