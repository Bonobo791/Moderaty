import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import AnalyticsPreference from './AnalyticsPreference.svelte';
import Footer from './landing/Footer.svelte';
import Hero from './landing/Hero.svelte';
import FinalCta from './landing/FinalCta.svelte';
import Pricing from './landing/Pricing.svelte';
import PlanHosted from './landing/PlanHosted.svelte';
import PlanLifetime from './landing/PlanLifetime.svelte';
import PlanSelfHosted from './landing/PlanSelfHosted.svelte';
import PricingPlans from './landing/pricing/PricingPlans.svelte';

test('prerenders an accessible preference control and privacy explanation without browser storage', () => {
	const body = render(AnalyticsPreference).body;
	expect(body).toContain('Audience measurement');
	expect(body).not.toContain('aria-pressed=');
	expect(body).toContain('Disable audience measurement');
	expect(body).toContain('href="/privacy#s12"');
	expect(body).toContain('disabled');
	expect(body).not.toContain('unavailable');
});

test.each([
	[() => render(Hero).body, 'connect_click', 'hero'], [() => render(FinalCta).body, 'connect_click', 'final_cta'],
	[() => render(PlanHosted).body, 'connect_click', 'plan_hosted'], [() => render(PlanLifetime).body, 'connect_click', 'plan_lifetime'],
	[() => render(PlanSelfHosted).body, 'source_click', 'plan_self_hosted'], [() => render(Pricing).body, 'pricing_click', 'home_pricing'],
	[() => render(PricingPlans).body, 'contact_click', 'pricing_contact']
] as const)('renders the approved %s CTA markers', (markup, event, placement) => {
	const body = markup();
	expect(body).toContain('data-moderaty-event="' + event + '" data-moderaty-placement="' + placement + '"');
});

test('footer provides the visitor control and reviewed source/pricing/contact markers', () => {
	const body = render(Footer).body;
	expect(body).toContain('Audience measurement');
	for (const event of ['source_click', 'pricing_click', 'contact_click']) {
		expect(body).toContain('data-moderaty-event="' + event + '" data-moderaty-placement="footer"');
	}
});
