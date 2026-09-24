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
