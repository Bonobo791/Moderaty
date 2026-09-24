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
import type Stripe from 'stripe';
import { handleStripeEvent } from '$lib/server/stripe/webhooks';
import { getStripe } from '$lib/server/stripe/client';

export const POST: RequestHandler = async ({ request }) => {
	const secret = env.STRIPE_WEBHOOK_SECRET;
	if (!secret) {
		console.error('stripe webhook: STRIPE_WEBHOOK_SECRET is not configured');
		throw error(500, 'webhook not configured');
	}
	// STRIPE_SECRET_KEY must be validated BEFORE the signature try: getStripe()
	// throws for a missing key, and swallowing that throw as a signature
	// failure would misreport a server configuration error as a 400 from
	// Stripe (codex review). A 500 keeps the operator's attention on the
	// deployment, where the key belongs.
	if (!env.STRIPE_SECRET_KEY) {
		console.error('stripe webhook: STRIPE_SECRET_KEY is not configured');
		throw error(500, 'stripe not configured');
	}
	const rawBody = await request.text();
	const signature = request.headers.get('stripe-signature');
	if (!signature) {
		console.error('stripe webhook: missing stripe-signature header');
		throw error(400, 'missing signature');
	}
	let event: Stripe.Event;
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
