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

// Stripe webhook endpoint. Signature verification is the ONLY auth (like the
// cron endpoint's Bearer secret): Stripe signs the raw body with the endpoint
// secret, and a verified request is by definition from Stripe. The raw body
// must be passed to constructEvent verbatim — JSON-parsing first breaks the
// signature. Handlers return 2xx fast; Stripe retries failures for up to 3
// days, and every handler is idempotent (stripe_events dedupe + ledger
// anchors), so retries are safe.

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { env } from '$env/dynamic/private';
import { handleStripeEvent } from '$lib/server/stripe/webhooks';
import { getStripe } from '$lib/server/stripe/client';

export const POST: RequestHandler = async ({ request }) => {
	const secret = env.STRIPE_WEBHOOK_SECRET;
	if (!secret) {
		console.error('stripe webhook: STRIPE_WEBHOOK_SECRET is not configured');
		throw error(500, 'webhook not configured');
	}
	const rawBody = await request.text();
	const signature = request.headers.get('stripe-signature');
	if (!signature) {
		console.error('stripe webhook: missing stripe-signature header');
		throw error(400, 'missing signature');
	}
	let event;
	try {
		event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
	} catch (verifyError) {
		console.error(`stripe webhook: signature verification failed: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`);
		throw error(400, 'invalid signature');
	}
	// Respond to Stripe quickly; the handlers themselves are idempotent.
	try {
		await handleStripeEvent(event);
	} catch (handlerError) {
		// A 5xx here tells Stripe to retry the delivery — correct for transient
		// failures, and safe because processing is idempotent.
		console.error(`stripe webhook: handler failed for ${event.type} ${event.id}: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`);
		throw error(500, 'handler failed');
	}
	return new Response(null, { status: 200 });
};
