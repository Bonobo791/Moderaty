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

import { fail, redirect } from '@sveltejs/kit';

import { CONTACT_OPT_IN_TEXT, parseContactForm, submitContactRequest } from '$lib/server/contact';

import type { Actions, PageServerLoad } from './$types';

// Public opt-in contact page. No session required — the verification e-mail
// is the identity gate. The exact opt-in sentence travels through the load
// (consents pattern), so the page can never drift from what is logged on the
// submission row.
export const load: PageServerLoad = ({ url }) => {
	return {
		optInText: CONTACT_OPT_IN_TEXT,
		// 303-redirect target after a successful submission (see the action):
		// a plain GET, so refreshing the success state never re-sends.
		sent: url.searchParams.get('sent') === '1'
	};
};

export const actions: Actions = {
	default: async ({ request, getClientAddress }) => {
		const form = await request.formData();
		const parsed = parseContactForm(form);
		if (!parsed.ok) {
			return fail(400, { error: parsed.error, values: { name: parsed.name, email: parsed.email } });
		}
		try {
			await submitContactRequest({
				name: parsed.name,
				email: parsed.email,
				consentText: CONTACT_OPT_IN_TEXT,
				ip: getClientAddress(),
				userAgent: request.headers.get('user-agent') ?? ''
			});
		} catch (error) {
			// Loud server log; generic client message (AGENTS.md — never leak
			// third-party response details to the client).
			// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
			console.error('contact verification e-mail send failed:', error);
			return fail(500, {
				error: 'We could not send the verification e-mail right now — please try again in a few minutes.',
				values: { name: parsed.name, email: parsed.email }
			});
		}
		throw redirect(303, '/contact?sent=1');
	}
};
