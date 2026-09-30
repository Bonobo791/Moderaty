import { describe, expect, test } from 'vitest';

import { forecastCost, forecastMonths, hostedCostUsd, validateCommentCount } from './cost';

describe('hosted cost calculator', () => {
	test('the free tier costs zero and paid usage includes the first 100 comments', () => {
		expect(hostedCostUsd(0)).toBe(0);
		expect(hostedCostUsd(100)).toBe(5);
		// 10 top-up credits can't be bought individually — the smallest
		// purchasable bundle is 500 credits for $20.40 (the 100-credit size
		// is automatic top-up only — codex; the remainder carries over).
		expect(hostedCostUsd(110)).toBeCloseTo(25.4, 5);
	});

	test('top-up comments price as the cheapest purchasable bundle combination', () => {
		// Manual credits only exist as fixed 500/2,000 bundles — the forecast
		// is the cheapest combination covering the usage, never a per-credit
		// rate nobody can buy (codex). Carry-over is real: leftovers persist.
		expect(hostedCostUsd(200)).toBeCloseTo(25.4, 5); // 100 top-up = one 500-bundle
		expect(hostedCostUsd(110)).toBeCloseTo(25.4, 5); // 10 top-up credits still need the whole bundle
		expect(hostedCostUsd(600)).toBeCloseTo(25.4, 5); // 500-bundle exactly
		expect(hostedCostUsd(1100)).toBeCloseTo(45.8, 5); // 1,000 top-up = two 500-bundles
		expect(hostedCostUsd(2100)).toBeCloseTo(69.65, 5); // 2,000-bundle
	});

	test('rejects fractional, negative, unsafe, and unbounded inputs', () => {
		for (const value of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 10_000_001]) {
			expect(() => validateCommentCount(value)).toThrow();
		}
	});

	test('returns a three-month average and a conservative low/high range', () => {
		const forecast = forecastCost([100, 200, 300]);
		expect(forecast.averageComments).toBe(200);
		expect(forecast.lowComments).toBe(100);
		expect(forecast.highComments).toBe(300);
		expect(forecast.lowCostUsd).toBe(5);
		expect(forecast.averageCostUsd).toBeCloseTo(25.4, 5);
		// 300 comments = $5 plan + 200 top-up credits = one 500-bundle ($20.40).
		expect(forecast.highCostUsd).toBeCloseTo(25.4, 5);
	});
});

describe('three-month forecast gate', () => {
	test('returns null until ALL three months are filled — a blank input is never treated as 0', () => {
		// forecastMonths([...]) feeds CostMath's "Forecast a range" calculator:
		// blank months must yield no forecast at all, not an instant low
		// estimate built on zeros (codex).
		expect(forecastMonths([undefined, undefined, undefined])).toBeNull();
		expect(forecastMonths([100, undefined, 300])).toBeNull();
		expect(forecastMonths([0, 0, 0])).not.toBeNull();
	});

	test('returns null when any filled month is invalid, and the forecast when all three are valid', () => {
		expect(forecastMonths([100, -1, 300])).toBeNull();
		expect(forecastMonths([100, 1.5, 300])).toBeNull();
		expect(forecastMonths([100, 200, 300])).toEqual(forecastCost([100, 200, 300]));
	});
});
