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
