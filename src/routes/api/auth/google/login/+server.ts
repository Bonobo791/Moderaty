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
import { readPendingStates, storePendingStates } from '$lib/server/oauthState';

// Step 1 of sign-in: Google *identity* (who you are). YouTube access is a
// separate consent at /api/auth/google so the sensitive scope is only
// requested when the user actually connects a channel.
export function GET({ cookies }: { cookies: import('@sveltejs/kit').Cookies }) {
	if (!env.GOOGLE_CLIENT_ID) throw error(500, 'GOOGLE_CLIENT_ID is not configured');
	// Stryker disable next-line ConditionalExpression: equivalent — with APP_URL unset, storePendingStates below calls cookieSecure(), which throws the identical error(500, 'APP_URL is not configured') before the redirect URL is built
	if (!env.APP_URL) throw error(500, 'APP_URL is not configured');

	// CSRF guard: bind the login request to this browser session. The new state
	// is appended rather than replacing the cookie so overlapping starts in
	// multiple tabs stay valid.
	const state = randomBytes(16).toString('hex');
	storePendingStates(cookies, [...readPendingStates(cookies), state]);

	const params = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		redirect_uri: new URL('/api/auth/google/login/callback', env.APP_URL).toString(),
		response_type: 'code',
		scope: 'openid email profile',
		state
	});
	throw redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
