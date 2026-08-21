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

export const MONTHLY_PLAN_USD = 5;
export const INCLUDED_COMMENTS = 100;
export const TOP_UP_USD_PER_COMMENT = 0.05;
export const MAX_CALCULATOR_COMMENTS = 10_000_000;

export function validateCommentCount(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CALCULATOR_COMMENTS) {
		throw new Error(`comment count must be an integer between 0 and ${MAX_CALCULATOR_COMMENTS}`);
	}
	return value;
}

export function hostedCostUsd(value: number): number {
	const comments = validateCommentCount(value);
	if (comments === 0) return 0;
	return MONTHLY_PLAN_USD + Math.max(0, comments - INCLUDED_COMMENTS) * TOP_UP_USD_PER_COMMENT;
}

export type CostForecast = {
	averageComments: number;
	averageCostUsd: number;
	lowComments: number;
	lowCostUsd: number;
	highComments: number;
	highCostUsd: number;
};

export function forecastCost(values: readonly number[]): CostForecast {
	if (values.length !== 3) throw new Error('cost forecast requires exactly three monthly comment counts');
	const comments = values.map(validateCommentCount);
	const averageComments = Math.round(comments.reduce((sum, count) => sum + count, 0) / comments.length);
	const lowComments = Math.min(...comments);
	const highComments = Math.max(...comments);
	return {
		averageComments,
		averageCostUsd: hostedCostUsd(averageComments),
		lowComments,
		lowCostUsd: hostedCostUsd(lowComments),
		highComments,
		highCostUsd: hostedCostUsd(highComments)
	};
}
