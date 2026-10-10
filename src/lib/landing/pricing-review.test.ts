import { existsSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import Pricing from '../components/landing/Pricing.svelte';
import PricingPage from '../../routes/pricing/+page.svelte';
import PlanSelfHosted from '../components/landing/PlanSelfHosted.svelte';
import Terms from '../components/landing/legal/Terms.svelte';
import { FAQ_ENTRIES } from './faq';
import { PRICING_FAQ_ENTRIES } from './pricing-faq';
import { TICKS_HOSTED, TICKS_HOSTED_DETAILED, TICKS_LIFETIME, TICKS_LIFETIME_DETAILED } from './plans';

vi.mock('$app/state', () => ({ page: { data: { locale: 'en' }, url: new URL('https://moderaty.example/pricing') } }));
vi.mock('$lib/credit-pricing', async original => ({
	...await original<typeof import('$lib/credit-pricing')>(),
	expectedBundlePriceCents: vi.fn((size: number) => size === 500 ? 1234 : 5678)
}));

test('homepage and pricing describe reusable lifetime places and shared AI classifications', () => {
	const home = render(Pricing).body + FAQ_ENTRIES.map(item => item.a).join(' ');
	const pricing = render(PricingPage);
	for (const text of [home, pricing.body, pricing.head, TICKS_LIFETIME.join(' '), TICKS_LIFETIME_DETAILED.join(' ')]) {
		expect(text).not.toMatch(/first 1,000 (?:users|purchases)|100 comments included/i);
		expect(text).toContain('1,000 lifetime places');
	}
	expect(home).toContain('100 AI classifications');
});

test('all bundle offers derive prices from the shared pricing calculation', () => {
	const pricing = render(PricingPage);
	expect(pricing.body).toContain('$17.34 including the subscription');
	for (const text of [render(Pricing).body, pricing.body, pricing.head, ...TICKS_HOSTED.filter(line => line.includes('500')), ...TICKS_HOSTED_DETAILED.filter(line => line.includes('500'))]) {
		expect(text).toContain('500 credits for $12.34 or 2,000 for $56.78');
		expect(text).not.toMatch(/\$20\.40|\$64\.65/);
	}
});

test('BYOK disclosure retains encrypted storage and processing purposes', () => {
	const answer = PRICING_FAQ_ENTRIES.find(item => item.q === 'What does BYOK mean?')?.a;
	expect(answer).toMatch(/stored encrypted/i);
	expect(answer).toMatch(/validate.*key/i);
	expect(answer).toMatch(/score comments/i);
});

test('custom and volume pricing remain available through contact', () => {
	expect(PRICING_FAQ_ENTRIES.find(item => item.q === 'Which one should I pick?')?.a).toMatch(/contact.*custom or volume pricing/i);
});

test('the rendered billing link points to an existing Terms section', () => {
	const page = render(PricingPage).body;
	expect(page).toContain('href="/terms#s6"');
	expect(render(Terms).body).toMatch(/<h2[^>]*id="s6"[^>]*>6\. Plans, Billing and Auto Top-Up<\/h2>/);
});

test('the removed WhyFree component has no orphan source', () => {
	expect(existsSync(new URL('../components/landing/pricing/WhyFree.svelte', import.meta.url))).toBe(false);
});

test('the license link uses the existing plan-body link styling', () => {
	expect(render(PlanSelfHosted).body).toMatch(/<a[^>]*class="inline-link"[^>]*>PolyForm Shield 1.0.0<\/a>/);
});
