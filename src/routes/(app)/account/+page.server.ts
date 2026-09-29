import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { deleteUserRecords, revokeChannelGrantsForUser } from '$lib/server/deletion';
import { requireUser, SESSION_COOKIE } from '$lib/server/session';
import { eq } from 'drizzle-orm';
import { fail, isHttpError, redirect } from '@sveltejs/kit';

/**
 * Loads the account settings page: the signed-in user's facts, their team
 * role, and how many YouTube channels the active team has connected.
 *
 * @returns The user's display name and e-mail, team role, channel count.
 */
export async function load({ locals }) {
	// Database outage: checked before requireUser because an outage means the
	// session lookup failed and locals.user is null — the maintenance page IS
	// the signed-in state.
	if (locals.dbDown) return { user: null, channelCount: 0, maintenance: true, orgRole: null };
	const user = requireUser(locals);
	try {
		// Only the count leaves the server — no channel rows, never any token.
		const rows = await db
			.select({ id: channels.id })
			.from(channels)
			.where(eq(channels.orgId, user.orgId))
			.all();
		return {
			user: { displayName: user.displayName, email: user.email },
			channelCount: rows.length,
			maintenance: false,
			orgRole: user.orgRole
		};
	} catch (e) {
		// A deliberate HttpError is NOT an outage — fail loudly, same as hooks.
		if (isHttpError(e)) throw e;
		// Intermittent outage: the hook queries succeeded but this one didn't.
		// Loud on the server, a maintenance state for the user — never a 500.
		console.error('account load failed:', e);
		return { user: null, channelCount: 0, maintenance: true, orgRole: null };
	}
}

export const actions = {
	deleteAccount: async ({ request, locals, cookies }) => {
		const user = requireUser(locals);
		const f = await request.formData();
		if (f.get('confirm') !== 'on') {
			return fail(400, { error: 'You must confirm account deletion to continue.' });
		}
		// Immediate deletion: everything is erased NOW except the evidentiary
		// consent log (statutory retention, LGPD Art. 16, III). Each channel's
		// YouTube grant is revoked at Google first (YouTube API ToS) — the
		// revocation helper logs failures loudly without blocking the erase.
		await revokeChannelGrantsForUser(user.id, 'account deletion');
		await deleteUserRecords(user.id);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		// The session is gone, so land on the public confirmation page — never
		// back on an (app) page that would just bounce to /login.
		throw redirect(303, '/account-deleted');
	}
};
