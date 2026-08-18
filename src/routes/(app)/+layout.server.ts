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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { redirect } from '@sveltejs/kit';

import { hasCurrentConsent } from '$lib/server/legal';
import { listOrgMemberships } from '$lib/server/org';
import { SESSION_COOKIE } from '$lib/server/session';

import type { LayoutServerLoad } from './$types';

// Everything under (app) requires a signed-in user whose consent covers the
// current LEGAL_VERSION. Sessions slide for 30 days, so without this gate a
// legal-doc bump would only reach users at their next login. /consent lives
// outside (app), so the redirect cannot loop.
// During a database outage (locals.dbDown) none of these queries can run:
// return the maintenance payload so the shell renders an overlay instead of
// bouncing the user to /login (which would look like a logout) or 500ing.
export const load: LayoutServerLoad = async ({ locals, cookies }) => {
	// Only a request carrying a session cookie gets the maintenance shell:
	// without one there is no session to protect, and the /login redirect
	// below costs no database query — the auth gate is not bypassed.
	if (locals.dbDown && cookies.get(SESSION_COOKIE)) return { user: locals.user, orgs: [], maintenance: true };
	if (!locals.user) throw redirect(302, '/login');
	if (!(await hasCurrentConsent(locals.user.id))) throw redirect(302, '/consent');
	return { user: locals.user, orgs: await listOrgMemberships(locals.user.id), maintenance: false };
};
