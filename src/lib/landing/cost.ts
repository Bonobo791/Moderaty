import { purchasableCreditCostUsd } from '$lib/credit-pricing';

export const MONTHLY_PLAN_USD = 5;
export const INCLUDED_COMMENTS = 100;
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
	// Past the included 100, top-up comments are forecast at the cheapest
	// purchasable combination of the fixed 100/500/2,000-credit bundles —
	// the per-tranche progressive rate is not buyable between bundle sizes,
	// so it would understate the real cost (codex).
	return MONTHLY_PLAN_USD + purchasableCreditCostUsd(Math.max(0, comments - INCLUDED_COMMENTS));
}

export type CostForecast = {
	averageComments: number;
	averageCostUsd: number;
	lowComments: number;
	lowCostUsd: number;
	highComments: number;
	highCostUsd: number;
};

/**
 * Forecasts from three monthly comment counts. A BLANK month (undefined) or
 * an invalid one yields null — never a forecast silently built on zeros.
 */
export function forecastMonths(months: readonly (number | undefined)[]): CostForecast | null {
	if (months.some((month) => month === undefined)) return null;
	const counts = months as number[];
	if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0 && count <= MAX_CALCULATOR_COMMENTS)) return null;
	return forecastCost(counts);
}

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
