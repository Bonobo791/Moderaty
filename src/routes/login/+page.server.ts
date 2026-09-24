import { redirect } from '@sveltejs/kit';

import type { PageServerLoad } from './$types';

// Already signed in? Straight to the app.
export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) throw redirect(302, '/dashboard');
	return {};
};
