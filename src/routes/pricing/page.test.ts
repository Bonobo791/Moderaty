import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
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
	expect(description).toMatch(/free to self-host/i);
	if (surface === 'search') {
		expect(description).toContain('500 or 2,000 credits');
	}
});
