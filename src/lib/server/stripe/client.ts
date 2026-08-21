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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

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
