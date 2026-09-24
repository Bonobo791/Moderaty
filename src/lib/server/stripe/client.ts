// Stripe SDK client — server-only (never import from client code). Lazy
// singleton for the same reason as the db client: Netlify's postbuild
// analyse imports every server module without runtime env vars, so
// validation happens at first use (handler start), not at module load.
// The API version is PINNED to the SDK's own version and must match the
// webhook endpoint's pinned version in the Stripe dashboard — event payloads
// follow the version in effect when they were created, so an unversioned
// endpoint would let payloads drift from these types.

import { env } from '$env/dynamic/private';
import Stripe from 'stripe';

let instance: Stripe | undefined;

/**
 * Provides the configured Stripe client.
 *
 * @returns The initialized Stripe client
 * @throws If `STRIPE_SECRET_KEY` is not configured
 */
export function getStripe(): Stripe {
	if (!instance) {
		const key = env.STRIPE_SECRET_KEY;
		if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
		// maxNetworkRetries 2: Stripe's API is idempotent-key safe, so a
		// network-level retry cannot duplicate a charge.
		instance = new Stripe(key, { apiVersion: '2026-07-29.dahlia', maxNetworkRetries: 2 });
	}
	return instance;
}
