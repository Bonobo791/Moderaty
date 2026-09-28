import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FAQ_ENTRIES } from './faq';
import { TICKS_SELF_HOSTED, TICKS_SELF_HOSTED_DETAILED } from './plans';
import { SCRIPT } from './queue-script';

describe('landing copy guardrails', () => {
	it('ships exactly the 9 FAQ pairs, each a real question with a real answer', () => {
		expect(FAQ_ENTRIES).toHaveLength(9);
		for (const { q, a } of FAQ_ENTRIES) {
			expect(q.endsWith('?')).toBe(true);
			expect(a.length).toBeGreaterThan(40);
		}
	});

	it('uses no em-dashes or en-dashes anywhere in FAQ or queue copy', () => {
		for (const { q, a } of FAQ_ENTRIES) {
			expect(q).not.toMatch(/[—–]/);
			expect(a).not.toMatch(/[—–]/);
		}
		for (const item of SCRIPT) {
			expect(item.text).not.toMatch(/[—–]/);
			expect(item.reason).not.toMatch(/[—–]/);
		}
	});

	it('states separate one-time moderation and first-page feedback previews accurately', () => {
		const previewFaq = FAQ_ENTRIES.find(({ q }) => q === 'Can I test Moderaty without changing anything on my channel?');
		expect(previewFaq?.a).toContain('Each channel gets 1 free moderation dry run and 1 free feedback dry run. Neither spends credits.');
		expect(previewFaq?.a).toContain('Moderation previews drain the selected window in the background; feedback previews cover the first page, up to 100 comments.');
		expect(TICKS_SELF_HOSTED.join(' ')).toContain('1 free dry run per feature per channel');
		expect(TICKS_SELF_HOSTED_DETAILED.join(' ')).toContain('1 free dry run per feature per channel');
		const howItWorks = readFileSync(new URL('../components/landing/HowItWorks.svelte', import.meta.url), 'utf8').replace(/\s+/g, ' ');
		const trustBar = readFileSync(new URL('../components/landing/TrustBar.svelte', import.meta.url), 'utf8').replace(/\s+/g, ' ');
		expect(howItWorks).toContain('Each channel gets 1 free moderation dry run and 1 free feedback dry run. Neither spends credits.');
		expect(howItWorks).toContain('Moderation previews drain the selected window in the background; feedback previews cover the first page, up to 100 comments.');
		expect(trustBar).toContain('1 free dry run per feature per channel');
		expect(trustBar).toContain('Moderation previews drain the selected window in the background');
	});
});
