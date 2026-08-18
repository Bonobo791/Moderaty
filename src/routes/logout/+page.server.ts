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

import { redirect } from '@sveltejs/kit';

import { destroySession, requireUser, SESSION_COOKIE } from '$lib/server/session';

import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = () => {
	throw redirect(302, '/login');
};

export const actions: Actions = {
	default: async ({ cookies, locals }) => {
		// Outage: identity cannot be resolved (locals.user is null), so
		// requireUser would 401 and strand the cookie with no recovery path.
		// The user asked to sign out — let them: clear the cookie so the
		// browser forgets the session. The row sweep is best-effort (the DB is
		// down; the sliding expiry reaps it later), loud on the server.
		if (!locals.dbDown) requireUser(locals);
		const token = cookies.get(SESSION_COOKIE);
		if (token) {
			try {
				await destroySession(token);
			} catch (e) {
				if (!locals.dbDown) throw e;
				console.error('logout during outage could not destroy the session row:', e);
			}
		}
		cookies.delete(SESSION_COOKIE, { path: '/' });
		throw redirect(302, '/login');
	}
};
