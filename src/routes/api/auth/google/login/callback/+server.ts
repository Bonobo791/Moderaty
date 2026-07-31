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

import { isNull, eq, sql } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { channels, users } from '$lib/server/db/schema';
import { exchangeGoogleCode } from '$lib/server/google';
import { readPendingStates, storePendingStates } from '$lib/server/oauthState';
import { createSession, SESSION_COOKIE } from '$lib/server/session';

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

	// Find-or-create the account by Google's stable sub claim. The orphan claim
	// is one-time initialization — only the FIRST user ever created (users table
	// empty before this insert) takes the pre-accounts ownerless channels, so a
	// later signup can never steal them. The transaction keeps the check, the
	// insert, and the claim from interleaving with a concurrent first sign-in.
	const user = await db.transaction(async (tx) => {
		const existing = await tx.select().from(users).where(eq(users.googleSub, sub)).get();
		if (existing) return existing;
		const count = await tx.select({ n: sql<number>`count(*)` }).from(users).get();
		// A concurrent same-sub sign-in can win the insert between the existence
		// check above and here — insert conflict-tolerantly and re-select instead
		// of surfacing a raw unique-violation to the user.
		await tx
			.insert(users)
			.values({ id: randomBytes(16).toString('hex'), googleSub: sub, email, displayName })
			.onConflictDoNothing();
		const created = await tx.select().from(users).where(eq(users.googleSub, sub)).get();
		if (!created) throw error(500, 'account creation failed — please retry');
		if (count?.n === 0) {
			await tx.update(channels).set({ userId: created.id }).where(isNull(channels.userId));
		}
		return created;
	});

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
