import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import { PRICING_FAQ_ENTRIES } from '$lib/landing/pricing-faq';
import PricingPage from './+page.svelte';

vi.mock('$app/state', () => ({
	page: { data: { locale: 'en' }, url: new URL('https://moderaty.example/pricing') }
}));

test.each([
	['search', /<meta\s+name="description"\s+content="([^"]*)"/g],
	['social', /<meta\s+property="og:description"\s+content="([^"]*)"/g]
] as const)('%s description explains the shared classification allowance', (surface, metadataTag) => {
	const tags = [...render(PricingPage).head.matchAll(metadataTag)];

	expect(tags).toHaveLength(1);
	const description = tags[0][1];

	expect(description).toMatch(/100 AI classifications shared (?:by|across) moderation(?: scoring)? and feedback digests/);
	expect(description).not.toMatch(/100 (?:AI-scored )?comments/);
	expect(description).toContain('$5 a month');
	expect(description).toContain('$49 once for lifetime hosting');
	expect(description).toContain('your own OpenAI key');
	expect(description).toContain('PolyForm Shield');
	expect(description).toMatch(/costs \$0 from Moderaty/i);
	expect(description).toMatch(/infrastructure and OpenAI charges are separate/i);
	expect(description).toMatch(/first 1,000 purchases/i);
	if (surface === 'search') {
		expect(description).toContain('500 or 2,000 credits');
	}
});

test('FAQ structured data matches the visible pricing FAQ source', () => {
	const rendered = render(PricingPage);
	const schema = rendered.head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
	if (!schema) throw new Error('Pricing FAQ JSON-LD is missing');
	const data = JSON.parse(schema);
	expect(data['@type']).toBe('FAQPage');
	expect(data.mainEntity).toEqual(PRICING_FAQ_ENTRIES.map(({ q, a }) => ({
		'@type': 'Question',
		name: q,
		acceptedAnswer: { '@type': 'Answer', text: a }
	})));
});
