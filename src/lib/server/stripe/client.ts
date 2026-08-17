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
