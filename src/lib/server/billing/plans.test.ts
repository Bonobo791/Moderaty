import { describe, expect, test } from 'vitest';
import { HOSTED_INCLUDED_CREDITS, LIFETIME_SLOT_LIMIT, planPriceEnv, validatePlanPrice } from './plans';

describe('plan catalog', () => {
	test('defines the advertised hosted and lifetime contracts', () => {
		expect(HOSTED_INCLUDED_CREDITS).toBe(100);
		expect(LIFETIME_SLOT_LIMIT).toBe(1000);
		expect(planPriceEnv('hosted')).toBe('STRIPE_PRICE_HOSTED_MONTHLY');
		expect(planPriceEnv('lifetime')).toBe('STRIPE_PRICE_LIFETIME');
	});

	test('accepts only an active one-time lifetime USD price at 49 dollars', () => {
		expect(() => validatePlanPrice('lifetime', { id: 'price_lifetime', active: true, currency: 'usd', type: 'one_time', unit_amount: 4900 })).not.toThrow();
		expect(() => validatePlanPrice('lifetime', { id: 'price_lifetime', active: true, currency: 'usd', type: 'recurring', unit_amount: 4900 })).toThrow(/one-time/);
		expect(() => validatePlanPrice('lifetime', { id: 'price_lifetime', active: true, currency: 'eur', type: 'one_time', unit_amount: 4900 })).toThrow(/USD/);
	});

	test('accepts only an active monthly hosted USD price at 5 dollars', () => {
		expect(() => validatePlanPrice('hosted', { id: 'price_hosted', active: true, currency: 'usd', type: 'recurring', unit_amount: 500, recurring: { interval: 'month', interval_count: 1 } })).not.toThrow();
		expect(() => validatePlanPrice('hosted', { id: 'price_hosted', active: true, currency: 'usd', type: 'recurring', unit_amount: 500, recurring: { interval: 'year', interval_count: 1 } })).toThrow(/monthly/);
		expect(() => validatePlanPrice('hosted', { id: 'price_hosted', active: true, currency: 'usd', type: 'recurring', unit_amount: 600, recurring: { interval: 'month', interval_count: 1 } })).toThrow(/500/);
	});
});
