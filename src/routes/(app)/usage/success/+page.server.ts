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

// Checkout success landing. The WEBHOOK is the authoritative fulfillment
// path; this page just runs the same idempotent fulfillCheckout for instant
// credits (research note §2: Checkout waits ~10s for the webhook, so the
// redirect alone is never enough). Fulfillment only runs for the signed-in
// user's OWN org — a session id belonging to another org is never fulfilled
// here, and any retrieval failure is logged loudly and left to the webhook.

import { requireUser } from '$lib/server/session';
import { getStripe } from '$lib/server/stripe/client';
import { fulfillCheckout } from '$lib/server/stripe/webhooks';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.dbDown) {
		return { maintenance: true, user: null, sessionId: null, granted: false, pending: false, failed: false };
	}
	const user = requireUser(locals);
	const sessionId = url.searchParams.get('session_id');
	if (!sessionId) return { maintenance: false, user, sessionId: null, granted: false, pending: false, failed: false };
	let granted = false;
	let pending = false;
	try {
		const session = await getStripe().checkout.sessions.retrieve(sessionId);
		if (session.metadata?.org_id !== user.orgId) {
			// Not this user's purchase — never fulfill (and never leak details).
			return { maintenance: false, user, sessionId, granted: false, pending: true, failed: false };
		}
		if (session.payment_status === 'unpaid') {
			pending = true;
		} else {
			// fulfillCheckout returns false when the grant was ALREADY applied
			// (the webhook beat the redirect — the common case). A paid session
			// for this org is a completed purchase either way: never show
			// "No purchase found" for a payment that succeeded.
			granted = (await fulfillCheckout(sessionId)) || session.payment_status === 'paid';
		}
	} catch (retrieveError) {
		// The webhook remains the source of truth; log loudly and show pending.
		console.error(`usage/success: could not fulfill ${sessionId}: ${retrieveError instanceof Error ? retrieveError.message : String(retrieveError)}`);
		pending = true;
	}
	return { maintenance: false, user, sessionId, granted, pending, failed: !granted && !pending };
};
