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

import { isHttpError } from '@sveltejs/kit';

import { cookieSecure } from '$lib/server/oauthState';
import { assertMigrationsCurrent } from '$lib/server/migrationGuard';
import { getSessionUser, SESSION_COOKIE } from '$lib/server/session';

// Resolves the session cookie into locals.user for every request. When the
// session slid into its renewal window, the cookie is refreshed with the new
// expiry so active users never get logged out. A database failure here does
// NOT produce a bare 500 (maintainer decision): the request degrades to
// maintenance mode — locals.dbDown is set, the failure is logged loudly on
// the server, and the (app) layout/dashboard render a user-visible
// maintenance overlay. A valid user sees a loud maintenance state, never a
// silent downgrade to signed-out.
export const handle: Handle = async ({ event, resolve }) => {
	// /api/health is the uptime probe (issue #82): its whole job is to report
	// database health itself, so it bypasses the migration guard and session
	// resolution — either one would convert a database outage into a 500
	// before the endpoint could answer with its documented 503.
	if (event.url.pathname === '/api/health') return resolve(event);
	// Deploy-ordering boundary (issue #81): if the database is behind the
	// deployed code's migration journal, every DB query would fail with
	// scattered "no such column" errors — fail the request here with one clear
	// 503 instead. The guard's deliberate HttpError passes through (a
	// deploy-ordering condition, NOT an outage — never degrades). A database
	// failure INSIDE the check is an outage: degrade to maintenance mode.
	// The site-wide coupling is intentional: the public pages are prerendered
	// and served statically (handle never runs for them), so every request that
	// reaches this point is DB-backed and would fail downstream anyway.
	try {
		await assertMigrationsCurrent();
	} catch (e) {
		if (isHttpError(e)) throw e;
		console.error('migration guard query failed:', e);
		event.locals.dbDown = true;
		event.locals.user = null;
		return resolve(event);
	}
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
		event.locals.dbDown = true;
		event.locals.user = null;
	}
	return resolve(event);
};
