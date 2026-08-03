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

import { error, redirect } from '@sveltejs/kit';

import { acceptInvite, previewInvite } from '$lib/server/org';
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
		await acceptInvite(user.id, token, params.token);
		throw redirect(303, '/dashboard');
	}
};
