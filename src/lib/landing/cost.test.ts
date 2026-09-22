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
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { describe, expect, test } from 'vitest';

import { forecastCost, forecastMonths, hostedCostUsd, validateCommentCount } from './cost';

describe('hosted cost calculator', () => {
	test('the free tier costs zero and paid usage includes the first 100 comments', () => {
		expect(hostedCostUsd(0)).toBe(0);
		expect(hostedCostUsd(100)).toBe(5);
		expect(hostedCostUsd(110)).toBe(5.5);
	});

	test('top-up comments price progressively through the volume bands', () => {
		// Each tranche past the included 100 pays its own band's rate — the
		// first 100 top-up comments at full price, the next 400 at the
		// 500-bundle rate (23% off), the rest at the 2,000-bundle rate
		// (41% off). Matches the cuts the Usage page's buy buttons advertise.
		expect(hostedCostUsd(200)).toBe(10); // 100 × $0.05
		expect(hostedCostUsd(600)).toBeCloseTo(25.4, 5); // + 400 × $0.0385
		expect(hostedCostUsd(2100)).toBeCloseTo(69.65, 5); // + 1500 × $0.0295
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
		expect(forecast.averageCostUsd).toBe(10);
		// 300 comments = $5 plan + 100 top-up at $0.05 + 100 at 23% off.
		expect(forecast.highCostUsd).toBeCloseTo(13.85, 5);
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
