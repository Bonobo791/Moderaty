// Credit-bundle catalog. Prices are Stripe-dashboard products referenced by
// env var (mode-scoped: test prices with test keys, live prices with live
// keys). A bundle whose price env var is unset is simply not offered — the
// usage page lists only configured bundles, and any attempt to buy one fails
// loudly (never silently picks another bundle).

import { env } from '$env/dynamic/private';

import { bundleDiscountPercent } from '$lib/credit-pricing';

export interface CreditBundle {
	/** Stable id, e.g. 'credits_100'. Used in Stripe metadata + ledger refs. */
	id: string;
	/** Number of comment credits in the bundle. */
	credits: number;
	/** Human label shown on the usage page. */
	label: string;
	/** Bulk discount vs. the 100-credit base price, advertised on the buy button. */
	discountPercent?: number;
	/** Env var holding the Stripe Price id for this bundle. */
	priceEnv: string;
	/** Retained for historical grants, excluded from new manual purchases. */
	hiddenFromPurchase?: boolean;
	autoTopupEligible?: boolean;
}

export const CREDIT_BUNDLES: CreditBundle[] = [
	{ id: 'credits_100', credits: 100, label: '100 comments', discountPercent: bundleDiscountPercent(100), priceEnv: 'STRIPE_PRICE_CREDITS_100', hiddenFromPurchase: true },
	{ id: 'credits_500', credits: 500, label: '500 comments', discountPercent: bundleDiscountPercent(500), priceEnv: 'STRIPE_PRICE_CREDITS_500', autoTopupEligible: true },
	{ id: 'credits_2000', credits: 2000, label: '2,000 comments', discountPercent: bundleDiscountPercent(2000), priceEnv: 'STRIPE_PRICE_CREDITS_2000', autoTopupEligible: true }
];

export function configuredAutoTopupBundles(): CreditBundle[] {
	return CREDIT_BUNDLES.filter((bundle) => {
		if (!bundle.autoTopupEligible || !env[bundle.priceEnv]) return false;
		try { priceIdFor(bundle); return true; }
		catch (cause) { console.error(`auto top-up bundle unavailable: ${bundle.priceEnv} is invalid`, cause); return false; }
	});
}

/** Missing/retired selections pause; missing deployment configuration throws before claiming. */
export function autoTopupBundle(choice: string | null): CreditBundle | null {
	const configured = configuredAutoTopupBundles();
	if (!configured.length) throw new Error('no eligible auto top-up bundle is configured — set a STRIPE_PRICE_CREDITS_500 or STRIPE_PRICE_CREDITS_2000 env var');
	return configured.find((bundle) => bundle.id === choice) ?? null;
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
 * Resolves a bundle for a MANUAL one-time purchase. Unlike `bundleById` —
 * which auto top-up and the webhook grant path use intentionally — this
 * rejects `hiddenFromPurchase` catalog entries: their buy button never
 * renders, so a request naming one is crafted and fails loudly (codeant).
 *
 * @param id - The stable ID of the bundle to purchase
 * @returns The matching purchasable credit bundle
 * @throws An error if the bundle is unknown or hidden from purchase
 */
export function purchasableBundleById(id: string): CreditBundle {
	const bundle = bundleById(id);
	if (bundle.hiddenFromPurchase) throw new Error(`credit bundle ${id} is not available for purchase`);
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
 * Lists credit bundles offered for manual one-time purchase on the usage
 * page — those with configured Stripe Price IDs that are not
 * hiddenFromPurchase.
 *
 * @returns The bundles whose Stripe Price environment variables are set
 */
export function configuredBundles(): CreditBundle[] {
	return CREDIT_BUNDLES.filter((bundle) => env[bundle.priceEnv] && !bundle.hiddenFromPurchase);
}
