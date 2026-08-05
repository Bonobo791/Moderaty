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

import { fail, redirect, type ActionFailure } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';

import { encrypt } from '$lib/server/crypto';
import { db } from '$lib/server/db';
import { organizations } from '$lib/server/db/schema';
import { fetchWithRetry } from '$lib/server/http';
import {
	createInvite,
	createOrg,
	leaveOrg,
	listMembers,
	listOpenInvites,
	removeMember,
	renameOrg,
	revokeInvite,
	setMemberRole,
	type OrgRole
} from '$lib/server/org';
import { requireOrgRole } from '$lib/server/ownership';
import { requireUser, SESSION_COOKIE } from '$lib/server/session';

import type { Actions, PageServerLoad } from './$types';

// Team settings for the ACTIVE team. Members see the roster; admin+ see
// invite management; owners see role controls (enforced server-side in org.ts).
export const load: PageServerLoad = async ({ locals, url }) => {
	// Database outage: the layout renders the overlay; this load must not 401
	// on the null-user outage shape.
	if (locals.dbDown)
		return {
			user: null,
			members: [],
			invites: [],
			inviteBase: new URL('/invite/', url.origin).toString(),
			maintenance: true,
			hasOpenAiKey: false
		};
	const user = requireUser(locals);
	const members = await listMembers(user.id, user.orgId);
	const invites =
		user.orgRole === 'admin' || user.orgRole === 'owner' ? await listOpenInvites(user.id, user.orgId) : [];
	// Never serialize secrets to the client: the page gets a boolean only.
	const keyRow = await db
		.select({ openaiKeyEnc: organizations.openaiKeyEnc })
		.from(organizations)
		.where(eq(organizations.id, user.orgId))
		.get();
	return {
		user,
		members,
		invites,
		inviteBase: new URL('/invite/', url.origin).toString(),
		hasOpenAiKey: Boolean(keyRow?.openaiKeyEnc)
	};
};

/** Wraps org.ts errors as form failures so the page shows .error-box (I12). */
async function guard<T>(fn: () => Promise<T>): Promise<T | ActionFailure<{ error: string }>> {
	try {
		return await fn();
	} catch (e) {
		const status = (e as { status?: number }).status;
		const message = (e as { body?: { message?: string } }).body?.message;
		if (typeof status === 'number' && message) return fail(status, { error: message });
		throw e;
	}
}

export const actions: Actions = {
	rename: async ({ request, locals }) => {
		const user = requireUser(locals);
		requireOrgRole(user, 'admin');
		const name = String((await request.formData()).get('name') ?? '');
		return guard(() => renameOrg(user.id, user.orgId, name));
	},
	createTeam: async ({ request, locals }) => {
		const user = requireUser(locals);
		const name = String((await request.formData()).get('name') ?? '');
		return guard(() => createOrg(user.id, name));
	},
	invite: async ({ request, locals }) => {
		const user = requireUser(locals);
		requireOrgRole(user, 'admin');
		const form = await request.formData();
		const role = String(form.get('role') ?? 'member');
		if (role !== 'admin' && role !== 'member') return fail(400, { error: 'role must be admin or member' });
		return guard(async () => ({ ok: true as const, inviteToken: await createInvite(user.id, user.orgId, role) }));
	},
	revokeInvite: async ({ request, locals }) => {
		const user = requireUser(locals);
		requireOrgRole(user, 'admin');
		const token = String((await request.formData()).get('token') ?? '');
		return guard(() => revokeInvite(user.id, token));
	},
	setRole: async ({ request, locals }) => {
		const user = requireUser(locals);
		requireOrgRole(user, 'owner');
		const form = await request.formData();
		const targetUserId = String(form.get('userId') ?? '');
		const role = String(form.get('role') ?? '') as OrgRole;
		return guard(() => setMemberRole(user.id, user.orgId, targetUserId, role));
	},
	remove: async ({ request, locals }) => {
		const user = requireUser(locals);
		requireOrgRole(user, 'admin');
		const targetUserId = String((await request.formData()).get('userId') ?? '');
		return guard(() => removeMember(user.id, user.orgId, targetUserId));
	},
	leave: async ({ locals, cookies }) => {
		const user = requireUser(locals);
		const token = cookies.get(SESSION_COOKIE);
		if (!token) return fail(401, { error: 'sign-in required' });
		const result = await guard(() => leaveOrg(user.id, token, user.orgId));
		// After leaving, this request's locals still point at the org the user
		// just left — re-rendering /org here would 404. A fresh request
		// re-resolves the active org (oldest remaining membership). leaveOrg
		// returns void, so an undefined guard result is success.
		if (result === undefined) throw redirect(303, '/dashboard');
		return result;
	},
	setOpenAiKey: async ({ request, locals }) => {
		const user = requireUser(locals);
		requireOrgRole(user, 'owner');
		const key = String((await request.formData()).get('openAiKey') ?? '').trim();
		if (!key.startsWith('sk-') || key.length > 200)
			return fail(400, { error: 'Enter a valid OpenAI API key (it starts with sk-).' });
		// Validate live against OpenAI before storing anything: a typo'd or
		// revoked key must not silently degrade scoring onto the review queue.
		let res: Response;
		try {
			res = await fetchWithRetry('https://api.openai.com/v1/models', {
				headers: { authorization: `Bearer ${key}` }
			});
		} catch (error) {
			console.error('OpenAI key validation request failed:', error);
			return fail(502, { error: 'Could not reach OpenAI to validate the key — try again in a moment.' });
		}
		if (res.status === 401 || res.status === 403)
			return fail(400, { error: 'OpenAI rejected that key — check it and try again.' });
		if (!res.ok) {
			console.error(`OpenAI key validation returned HTTP ${res.status}`);
			return fail(502, { error: 'OpenAI could not validate the key right now — try again in a moment.' });
		}
		await db.update(organizations).set({ openaiKeyEnc: encrypt(key) }).where(eq(organizations.id, user.orgId));
		return { ok: true as const };
	},
	clearOpenAiKey: async ({ locals }) => {
		const user = requireUser(locals);
		requireOrgRole(user, 'owner');
		await db.update(organizations).set({ openaiKeyEnc: null }).where(eq(organizations.id, user.orgId));
		return { ok: true as const };
	}
};
