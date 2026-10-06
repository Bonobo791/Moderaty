import { purchasableCreditEstimate } from '$lib/credit-pricing';

export const MONTHLY_PLAN_USD = 5;
export const INCLUDED_COMMENTS = 100;
export const MAX_CALCULATOR_COMMENTS = 10_000_000;

/** Blank form inputs are incomplete, not invalid; zero remains a real count. */
export function validCountInput(value: number | null | undefined): boolean {
	return value == null || (Number.isSafeInteger(value) && value >= 0 && value <= MAX_CALCULATOR_COMMENTS);
}

export function validateCommentCount(value: number): number {
	if (value == null || !validCountInput(value)) {
		throw new Error(`comment count must be an integer between 0 and ${MAX_CALCULATOR_COMMENTS}`);
	}
	return value;
}

/** A full paid monthly allowance, zero purchased balance, and manual bundles. */
export function estimateHostedMonth(moderationClassifications: number, digestClassifications = 0) {
	const classifications = validateCommentCount(moderationClassifications) + validateCommentCount(digestClassifications);
	const includedUsed = Math.min(classifications, INCLUDED_COMMENTS);
	const purchasedUsed = classifications - includedUsed;
	const purchase = purchasableCreditEstimate(purchasedUsed);
	return {
		classifications,
		includedUsed,
		purchasedUsed,
		topupCredits: purchase.credits,
		topupCostUsd: purchase.costUsd,
		remainingPurchasedCredits: purchase.credits - purchasedUsed,
		cashCostUsd: MONTHLY_PLAN_USD + purchase.costUsd
	};
}

export function hostedCostUsd(value: number, digestClassifications = 0): number {
	return estimateHostedMonth(value, digestClassifications).cashCostUsd;
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
 * Forecasts from three monthly classification counts. A BLANK month or
 * an invalid one yields null — never a forecast silently built on zeros.
 */
export function forecastMonths(months: ReadonlyArray<number | null | undefined>): CostForecast | null {
	if (months.some((month) => month == null)) return null;
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
