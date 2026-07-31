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

import { redirect } from '@sveltejs/kit';

import { destroySession, requireUser, SESSION_COOKIE } from '$lib/server/session';

import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = () => {
	throw redirect(302, '/login');
};

export const actions: Actions = {
	default: async ({ cookies, locals }) => {
		requireUser(locals);
		const token = cookies.get(SESSION_COOKIE);
		if (token) await destroySession(token);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		throw redirect(302, '/login');
	}
};
