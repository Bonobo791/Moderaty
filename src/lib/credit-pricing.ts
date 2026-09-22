// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Advanced Digital Marketing LTDA
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

// Volume pricing for top-up credits — the single source for BOTH the Stripe
// bundle catalog (src/lib/server/stripe/bundles.ts) and the landing cost
// calculators (src/lib/landing/cost.ts), so the cut a bundle advertises and
// the rate a calculator charges can never drift. Client-safe: no env, no
// server-only imports.

/** Per-credit price at the base tier — the 100-credit bundle's rate. */
export const USD_PER_CREDIT = 0.05;

/**
 * Progressive bands on purchased credits, upper edge = bundle size: the
 * first 100 credits pay full price, the next 400 pay the 500-credit-bundle
 * rate (23% off), and everything past 500 pays the 2,000-credit-bundle rate
 * (41% off) — the deepest published tier.
 */
export const CREDIT_PRICE_BANDS = [
	{ upToCredits: 100, percentOff: 0 },
	{ upToCredits: 500, percentOff: 23 },
	{ upToCredits: Number.POSITIVE_INFINITY, percentOff: 41 }
] as const;

/**
 * Progressive USD price for `credits` purchased credits: each tranche pays
 * its own band's rate, tax-bracket style — 600 credits cost 100 at full
 * price, 400 at 23% off, and 100 at 41% off.
 */
export function progressiveCreditCostUsd(credits: number): number {
	let cost = 0;
	let covered = 0;
	for (const band of CREDIT_PRICE_BANDS) {
		if (credits <= covered) break;
		cost += (Math.min(credits, band.upToCredits) - covered) * USD_PER_CREDIT * (1 - band.percentOff / 100);
		covered = band.upToCredits;
	}
	return cost;
}

/**
 * The cut a bundle of `credits` credits advertises — the percentOff of the
 * band that size falls into (a 2,000-credit bundle lands in the deepest
 * band: 41% off), or undefined at the base tier.
 */
export function bundleDiscountPercent(credits: number): number | undefined {
	const band = CREDIT_PRICE_BANDS.find((candidate) => credits <= candidate.upToCredits);
	return band && band.percentOff > 0 ? band.percentOff : undefined;
}
