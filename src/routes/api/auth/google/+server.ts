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

import { error, redirect } from '@sveltejs/kit';

import { randomBytes } from 'node:crypto';

import { env } from '$env/dynamic/private';
import { createChannelState } from '$lib/server/channelConnect';
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
	// A signed-in connect uses a SELF-AUTHENTICATING state: the state value is
	// the AES-256-GCM-encrypted `{ userId, ts }` of the starter, so the callback
	// derives the starter from the state itself. That makes the binding
	// unforgeable AND immune to the shared-cookie read-modify-write race
	// (a concurrent tab's write may drop this flow's cookie entry, but the
	// state's own signature remains the authority). A signed-out start parks no
	// binding and dies at the callback.
	const state = locals.user ? createChannelState(locals.user.id) : randomBytes(16).toString('hex');
	storePendingStates(cookies, [...readPendingStates(cookies), state]);

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
