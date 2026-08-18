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

import { error } from '@sveltejs/kit';

import { verifyContactToken } from '$lib/server/contact';

import type { PageServerLoad } from './$types';

// Landing page for the verification link in the opt-in e-mail. The GET both
// confirms the address (flips the pending row to verified — idempotent, so
// re-opening the link is safe) and renders the outcome. A tokenless visit is
// a plain 400: the link always carries a token.
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	if (!token) throw error(400, 'missing verification token');
	const result = await verifyContactToken(token);
	return { state: result.status, email: 'email' in result ? result.email : null };
};
