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

import { describe, expect, test } from 'vitest';

import { CREDIT_PRICE_BANDS, USD_PER_CREDIT, bundleDiscountPercent, expectedBundlePriceCents, progressiveCreditCostUsd } from './credit-pricing';
import { CREDIT_BUNDLES } from './server/stripe/bundles';

describe('credit volume pricing', () => {
	test('the Stripe catalog advertises exactly the table-derived cuts — no drift', () => {
		// bundles.ts derives discountPercent from the shared table; this pins
		// the wiring so the Usage-page buttons and the landing calculators can
		// never disagree about what a bundle saves.
		expect(CREDIT_BUNDLES.map((bundle) => [bundle.id, bundle.discountPercent])).toEqual([
			['credits_100', undefined],
			['credits_500', 18],
			['credits_2000', 35]
		]);
		for (const bundle of CREDIT_BUNDLES) {
			expect(bundleDiscountPercent(bundle.credits)).toBe(bundle.discountPercent);
		}
	});

	test('the advertised cut is the EFFECTIVE cut of the progressive price — never the marginal band rate', () => {
		// The band rates apply per-tranche: a 500-credit bundle's deepest
		// tranche is 23% off, but the bundle as a whole saves 18.4% — the
		// button must advertise the effective cut or the label overstates
		// what the buyer actually saves (codex).
		expect(bundleDiscountPercent(500)).toBe(Math.floor((1 - progressiveCreditCostUsd(500) / (500 * USD_PER_CREDIT)) * 100));
		expect(bundleDiscountPercent(2000)).toBe(35);
		expect(bundleDiscountPercent(100)).toBeUndefined();
		expect(bundleDiscountPercent(0)).toBeUndefined();
	});

	test('expectedBundlePriceCents is the configured Stripe amount for each bundle', () => {
		// The checkout validates the operator's configured Price against this
		// catalog amount — a mismatch means the advertised discount is a lie.
		expect(expectedBundlePriceCents(100)).toBe(500);
		expect(expectedBundlePriceCents(500)).toBe(2040);
		expect(expectedBundlePriceCents(2000)).toBe(6465);
	});

	test('each tranche pays its own band rate — progressive, not flat', () => {
		expect(progressiveCreditCostUsd(0)).toBe(0);
		expect(progressiveCreditCostUsd(100)).toBe(100 * USD_PER_CREDIT); // 5.00 flat
		// 500 credits: 100 at $0.05 + 400 at $0.0385 — NOT 500 × $0.0385.
		expect(progressiveCreditCostUsd(500)).toBeCloseTo(5 + 15.4, 5);
		// Past 500 the rate drops again; the boundary credit itself is priced.
		expect(progressiveCreditCostUsd(501)).toBeCloseTo(5 + 15.4 + USD_PER_CREDIT * 0.59, 5);
		// 2000 credits: +1500 × $0.0295.
		expect(progressiveCreditCostUsd(2000)).toBeCloseTo(5 + 15.4 + 44.25, 5);
	});
});
