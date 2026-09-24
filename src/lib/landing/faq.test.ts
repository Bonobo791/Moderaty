import { describe, expect, it } from 'vitest';
import { FAQ_ENTRIES } from './faq';
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
});
