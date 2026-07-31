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

import type { Handle } from '@sveltejs/kit';

import { error } from '@sveltejs/kit';

import { cookieSecure } from '$lib/server/oauthState';
import { getSessionUser, SESSION_COOKIE } from '$lib/server/session';

// Resolves the session cookie into locals.user for every request. When the
// session slid into its renewal window, the cookie is refreshed with the new
// expiry so active users never get logged out. A database failure here fails
// loudly (AGENTS.md): a valid user must see a server error, not a silent
// downgrade to signed-out.
export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	try {
		const resolution = await getSessionUser(token);
		event.locals.user = resolution?.user ?? null;
		if (resolution?.renewed && token) {
			event.cookies.set(SESSION_COOKIE, token, {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				secure: cookieSecure(),
				expires: new Date(resolution.expiresAt)
			});
		}
	} catch (e) {
		console.error('session lookup failed:', e);
		throw error(500, 'something went wrong on our side — please retry');
	}
	return resolve(event);
};
