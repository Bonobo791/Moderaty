export const HOSTED_INCLUDED_CREDITS = 100;
export const LIFETIME_SLOT_LIMIT = 1000;

const HOSTED_PRICE_RECURRING_ERROR = 'hosted Stripe Price must be monthly recurring';
const LIFETIME_PRICE_ONE_TIME_ERROR = 'lifetime Stripe Price must be one-time';

export type PaidPlan = 'hosted' | 'lifetime';

type PriceLike = {
	id?: unknown;
	active?: unknown;
	currency?: unknown;
	type?: unknown;
	unit_amount?: unknown;
	recurring?: { interval?: unknown; interval_count?: unknown } | null;
};

export function planPriceEnv(plan: PaidPlan): 'STRIPE_PRICE_HOSTED_MONTHLY' | 'STRIPE_PRICE_LIFETIME' {
	return plan === 'hosted' ? 'STRIPE_PRICE_HOSTED_MONTHLY' : 'STRIPE_PRICE_LIFETIME';
}

export function validatePlanPrice(plan: PaidPlan, price: PriceLike): void {
	if (price.active !== true) throw new Error(`${plan} Stripe Price is inactive`);
	if (price.currency !== 'usd') throw new Error(`${plan} Stripe Price must be USD`);
	if (price.unit_amount !== (plan === 'hosted' ? 500 : 4900)) {
		throw new Error(`${plan} Stripe Price must be ${plan === 'hosted' ? '500' : '4900'} cents`);
	}
	if (plan === 'hosted') {
		if (price.type !== 'recurring' || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1) {
			throw new Error(HOSTED_PRICE_RECURRING_ERROR);
		}
		return;
	}
	if (price.type !== 'one_time') throw new Error(LIFETIME_PRICE_ONE_TIME_ERROR);
}
