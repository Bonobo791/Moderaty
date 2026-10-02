import { error, fail } from '@sveltejs/kit';
import { getContactVerificationStatus, verifyContactToken, type ContactVerificationResult } from '$lib/server/contact';
import type { Actions, PageServerLoad } from './$types';

/** Reads the bearer token shared by the read-only landing and confirmation action. */
function verificationToken(url: URL): string {
	const token = url.searchParams.get('token');
	if (!token) throw error(400, 'missing verification token');
	return token;
}

/** Exposes only a client-safe state and address, never stored message content. */
function pageState(result: ContactVerificationResult) {
	return { state: result.status, email: 'email' in result ? result.email : null };
}

// Mail security scanners may GET a link. Only an explicit form POST confirms
// the request and queues delivery; viewing or reloading never sends e-mail.
export const load: PageServerLoad = async ({ url }) => pageState(await getContactVerificationStatus(verificationToken(url)));

export const actions: Actions = {
	default: async ({ url, request }) => {
		const token = verificationToken(url);
		if ((await request.formData()).get('confirm') !== 'yes') return fail(400, { error: 'Please confirm your contact request.' });
		return pageState(await verifyContactToken(token));
	}
};
