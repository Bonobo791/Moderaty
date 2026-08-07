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

import { error, redirect } from '@sveltejs/kit';

import { randomBytes } from 'node:crypto';

import { env } from '$env/dynamic/private';
import { parkChannelState } from '$lib/server/channelConnect';
import { readPendingStates, storePendingStates } from '$lib/server/oauthState';
import type { SessionUser } from '$lib/server/session';

export function GET({
	cookies,
	locals
}: {
	cookies: import('@sveltejs/kit').Cookies;
	locals: { user: SessionUser | null };
}) {
	if (!env.GOOGLE_CLIENT_ID) throw error(500, 'GOOGLE_CLIENT_ID is not configured');
	// Stryker disable next-line ConditionalExpression: equivalent — with this check removed, an unset APP_URL still throws the identical 500 'APP_URL is not configured' from cookieSecure() inside storePendingStates below, before any cookie write or redirect; the StringLiteral sibling on this line is NOT swept (directive is scoped to ConditionalExpression)
	if (!env.APP_URL) throw error(500, 'APP_URL is not configured');

	// CSRF guard: bind the auth request to this browser session. The new state
	// is appended rather than replacing the cookie so overlapping starts in
	// multiple tabs stay valid.
	const state = randomBytes(16).toString('hex');
	storePendingStates(cookies, [...readPendingStates(cookies), state]);
	// Bind the state to the signed-in user who started the connect (the hooks
	// layout resolves the session for every request). The callback rejects a
	// completion by a DIFFERENT user before the authorization code is used —
	// a signed-out start parks no binding and dies at the callback (CodeRabbit
	// 3738037981).
	if (locals.user) parkChannelState(cookies, state, locals.user.id);

	const params = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		redirect_uri: new URL('/api/auth/google/callback', env.APP_URL).toString(),
		response_type: 'code',
		scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
		access_type: 'offline',
		// consent forces a fresh refresh_token on every connect; select_account
		// lets the user connect a channel that lives under a DIFFERENT Google
		// account than the one the browser is currently signed into.
		prompt: 'consent select_account',
		state
	});
	throw redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
