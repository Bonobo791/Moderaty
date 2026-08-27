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

import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { decrypt } from '$lib/server/crypto';
import { deleteUserRecords } from '$lib/server/deletion';
import { revokeGoogleToken } from '$lib/server/google';
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
		// YouTube grant is revoked at Google first (YouTube API ToS); a
		// revocation failure is logged loudly but does not block deletion — the
		// encrypted token is erased either way, orphaning the grant.
		// Revocation is connector-scoped (channels.userId = the account being
		// deleted): those Google grants belong to THIS user. Channels in teams
		// that survive the deletion keep their rows; their dead token will fail
		// loudly in cron until a teammate reconnects the channel.
		const owned = await db
			.select({ id: channels.id, refreshTokenEnc: channels.refreshTokenEnc })
			.from(channels)
			.where(eq(channels.userId, user.id))
			.all();
		for (const ch of owned) {
			try {
				await revokeGoogleToken(decrypt(ch.refreshTokenEnc), `account deletion channel ${ch.id}`);
			} catch (cause) {
				console.error('token revocation failed for channel, deleting anyway:', ch.id, cause);
			}
		}
		await deleteUserRecords(user.id);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		// The session is gone, so land on the public confirmation page — never
		// back on an (app) page that would just bounce to /login.
		throw redirect(303, '/account-deleted');
	}
};
