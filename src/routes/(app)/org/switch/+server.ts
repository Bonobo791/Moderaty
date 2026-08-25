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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { error, redirect } from '@sveltejs/kit';

import { switchActiveOrg } from '$lib/server/org';
import { cookieSecure } from '$lib/server/oauthState';
import { requireUser, SESSION_COOKIE } from '$lib/server/session';

import type { RequestHandler } from './$types';

// Nav team switcher target. 303 back to the dashboard so the POST is never replayed.
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	const user = requireUser(locals);
	const token = cookies.get(SESSION_COOKIE);
	if (!token) throw error(401, 'sign-in required');
	const form = await request.formData();
	const orgId = String(form.get('orgId') ?? '');
	if (!orgId) throw error(400, 'missing team');
	// Resolve the cookie-secure flag BEFORE rotating: a misconfigured
	// production (http APP_URL) throws here, while the old token is still
	// valid — never delete the working token and then fail to issue the
	// replacement (that would sign the user out).
	const secure = cookieSecure();
	// switchActiveOrg rotates the session: the pre-switch token dies, so the
	// response must hand the fresh token back in the cookie.
	const { token: newToken, expiresAt } = await switchActiveOrg(user.id, token, orgId);
	cookies.set(SESSION_COOKIE, newToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		expires: new Date(expiresAt)
	});
	throw redirect(303, '/dashboard');
};
