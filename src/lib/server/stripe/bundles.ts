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

/** The smallest configured bundle — the one auto top-up charges. */
export function autoTopupBundle(): CreditBundle {
	const configured = CREDIT_BUNDLES.filter((bundle) => env[bundle.priceEnv]);
	const smallest = configured.reduce<CreditBundle | null>(
		(best, bundle) => (best === null || bundle.credits < best.credits ? bundle : best),
		null
	);
	if (!smallest) throw new Error('no credit bundle is configured — set a STRIPE_PRICE_CREDITS_* env var');
	return smallest;
}

/** Looks up a bundle by id, throwing a loud 400-style error for unknown ids. */
export function bundleById(id: string): CreditBundle {
	const bundle = CREDIT_BUNDLES.find((candidate) => candidate.id === id);
	if (!bundle) throw new Error(`unknown credit bundle: ${id}`);
	return bundle;
}

/** The Stripe Price id for a bundle, from env — missing config fails loudly. */
export function priceIdFor(bundle: CreditBundle): string {
	const priceId = env[bundle.priceEnv];
	if (!priceId) throw new Error(`${bundle.priceEnv} is not configured`);
	if (!priceId.startsWith('price_')) throw new Error(`${bundle.priceEnv} must be a Stripe Price id (price_...)`);
	return priceId;
}

/** Bundles the usage page can offer right now (price env configured). */
export function configuredBundles(): CreditBundle[] {
	return CREDIT_BUNDLES.filter((bundle) => env[bundle.priceEnv]);
}
