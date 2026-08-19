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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// Credit-bundle catalog. Prices are Stripe-dashboard products referenced by
// env var (mode-scoped: test prices with test keys, live prices with live
// keys). A bundle whose price env var is unset is simply not offered — the
// usage page lists only configured bundles, and any attempt to buy one fails
// loudly (never silently picks another bundle).

import { env } from '$env/dynamic/private';

export interface CreditBundle {
	/** Stable id, e.g. 'credits_100'. Used in Stripe metadata + ledger refs. */
	id: string;
	/** Number of comment credits in the bundle. */
	credits: number;
	/** Human label shown on the usage page. */
	label: string;
	/** Env var holding the Stripe Price id for this bundle. */
	priceEnv: string;
}

export const CREDIT_BUNDLES: CreditBundle[] = [
	{ id: 'credits_100', credits: 100, label: '100 comments', priceEnv: 'STRIPE_PRICE_CREDITS_100' },
	{ id: 'credits_500', credits: 500, label: '500 comments', priceEnv: 'STRIPE_PRICE_CREDITS_500' },
	{ id: 'credits_2000', credits: 2000, label: '2,000 comments', priceEnv: 'STRIPE_PRICE_CREDITS_2000' }
];

/**
 * Selects the smallest configured credit bundle for automatic top-ups.
 *
 * @returns The configured bundle with the fewest credits
 * @throws {Error} If no credit bundle is configured
 */
export function autoTopupBundle(): CreditBundle {
	const configured = CREDIT_BUNDLES.filter((bundle) => env[bundle.priceEnv]);
	const smallest = configured.reduce<CreditBundle | null>(
		(best, bundle) => (best === null || bundle.credits < best.credits ? bundle : best),
		null
	);
	if (!smallest) throw new Error('no credit bundle is configured — set a STRIPE_PRICE_CREDITS_* env var');
	return smallest;
}

/**
 * Finds a credit bundle by its stable ID.
 *
 * @param id - The stable ID of the bundle to find
 * @returns The matching credit bundle
 * @throws An error if no bundle has the specified ID
 */
export function bundleById(id: string): CreditBundle {
	const bundle = CREDIT_BUNDLES.find((candidate) => candidate.id === id);
	if (!bundle) throw new Error(`unknown credit bundle: ${id}`);
	return bundle;
}

/**
 * Resolves and validates the Stripe Price ID configured for a credit bundle.
 *
 * @param bundle - The credit bundle whose configured Stripe Price ID to retrieve
 * @returns The configured Stripe Price ID
 * @throws If the price is not configured or does not start with `price_`
 */
export function priceIdFor(bundle: CreditBundle): string {
	const priceId = env[bundle.priceEnv];
	if (!priceId) throw new Error(`${bundle.priceEnv} is not configured`);
	if (!priceId.startsWith('price_')) throw new Error(`${bundle.priceEnv} must be a Stripe Price id (price_...)`);
	return priceId;
}

/**
 * Lists credit bundles with configured Stripe Price IDs.
 *
 * @returns The bundles whose Stripe Price environment variables are set
 */
export function configuredBundles(): CreditBundle[] {
	return CREDIT_BUNDLES.filter((bundle) => env[bundle.priceEnv]);
}
