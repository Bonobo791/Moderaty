import { error, redirect } from '@sveltejs/kit';

import { acceptInvite, previewInvite } from '$lib/server/org';
import { cookieSecure } from '$lib/server/oauthState';
import { requireUser, SESSION_COOKIE } from '$lib/server/session';

import type { Actions, PageServerLoad } from './$types';

// Public invite landing. Unknown tokens are a plain 404 — never leak which
// tokens exist. Logged-out visitors are asked to sign in and come back to
// this same URL (invites stay valid for 7 days).
export const load: PageServerLoad = async ({ params, locals }) => {
	const invite = await previewInvite(params.token);
	if (!invite) throw error(404, 'invite not found');
	return { invite, signedIn: locals.user !== null };
};

export const actions: Actions = {
	default: async ({ params, locals, cookies }) => {
		const user = requireUser(locals);
		const token = cookies.get(SESSION_COOKIE);
		if (!token) throw error(401, 'sign-in required');
		// Resolve the cookie-secure flag BEFORE rotating: a misconfigured
		// production (http APP_URL) throws here while the old token is still
		// valid and the invite is still open — never burn the invite / delete
		// the working token and then fail to issue the replacement.
		const secure = cookieSecure();
		// acceptInvite rotates the session: the pre-accept token dies, so the
		// response must hand the fresh token back in the cookie.
		const { session } = await acceptInvite(user.id, token, params.token);
		cookies.set(SESSION_COOKIE, session.token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure,
			expires: new Date(session.expiresAt)
		});
		throw redirect(303, '/dashboard');
	}
};
