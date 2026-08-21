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

import { forecastCost, hostedCostUsd, validateCommentCount } from './cost';

describe('hosted cost calculator', () => {
	test('the free tier costs zero and paid usage includes the first 100 comments', () => {
		expect(hostedCostUsd(0)).toBe(0);
		expect(hostedCostUsd(100)).toBe(5);
		expect(hostedCostUsd(110)).toBe(5.5);
	});

	test('rejects fractional, negative, unsafe, and unbounded inputs', () => {
		for (const value of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 10_000_001]) {
			expect(() => validateCommentCount(value)).toThrow();
		}
	});

	test('returns a three-month average and a conservative low/high range', () => {
		expect(forecastCost([100, 200, 300])).toEqual({
		averageComments: 200,
		averageCostUsd: 10,
		lowComments: 100,
		lowCostUsd: 5,
		highComments: 300,
		highCostUsd: 15
	});
	});
});
