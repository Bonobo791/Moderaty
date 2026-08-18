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
