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

import { hasCurrentConsent } from '$lib/server/legal';
import { listOrgMemberships } from '$lib/server/org';

import type { LayoutServerLoad } from './$types';

// Everything under (app) requires a signed-in user whose consent covers the
// current LEGAL_VERSION. Sessions slide for 30 days, so without this gate a
// legal-doc bump would only reach users at their next login. /consent lives
// outside (app), so the redirect cannot loop.
// During a database outage (locals.dbDown) none of these queries can run:
// return the maintenance payload so the shell renders an overlay instead of
// bouncing the user to /login (which would look like a logout) or 500ing.
export const load: LayoutServerLoad = async ({ locals }) => {
	if (locals.dbDown) return { user: locals.user, orgs: [], maintenance: true };
	if (!locals.user) throw redirect(302, '/login');
	if (!(await hasCurrentConsent(locals.user.id))) throw redirect(302, '/consent');
	return { user: locals.user, orgs: await listOrgMemberships(locals.user.id), maintenance: false };
};
