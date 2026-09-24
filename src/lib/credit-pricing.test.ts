import { describe, expect, test } from 'vitest';

import { CREDIT_PRICE_BANDS, USD_PER_CREDIT, bundleDiscountPercent, expectedBundlePriceCents, progressiveCreditCostUsd, purchasableCreditCostUsd } from './credit-pricing';
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

	test('purchasableCreditCostUsd prices only real bundle combinations — never unpurchasable marginal rates', () => {
		// The progressive rate past 500 cannot actually be bought: the codex
		// example — 1,000 credits forecast at $35.15 understates the cheapest
		// real purchase, two 500-bundles at $40.80.
		expect(purchasableCreditCostUsd(0)).toBe(0);
		expect(purchasableCreditCostUsd(50)).toBe(5); // smallest bundle covers
		expect(purchasableCreditCostUsd(100)).toBe(5);
		expect(purchasableCreditCostUsd(450)).toBeCloseTo(20.4, 5); // overshoot: one 500 beats five 100s
		expect(purchasableCreditCostUsd(500)).toBeCloseTo(20.4, 5);
		expect(purchasableCreditCostUsd(600)).toBeCloseTo(25.4, 5); // 500 + 100
		expect(purchasableCreditCostUsd(1000)).toBeCloseTo(40.8, 5); // two 500s — NOT $35.15
		expect(purchasableCreditCostUsd(1900)).toBeCloseTo(64.65, 5); // one 2,000 covers it cheaper than exact smalls
		expect(purchasableCreditCostUsd(2000)).toBeCloseTo(64.65, 5);
		expect(purchasableCreditCostUsd(2100)).toBeCloseTo(69.65, 5); // 2,000 + 100
		expect(purchasableCreditCostUsd(2900)).toBeCloseTo(105.05, 5); // 2,000 + 500 + 4×100
		expect(purchasableCreditCostUsd(10_000)).toBeCloseTo(5 * 64.65, 5); // five 2,000s
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
