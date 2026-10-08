import { expect, test } from 'vitest';
import { matchPreparedRule, prepareRules } from '$lib/server/rules';
import { SPAM_RULE_EXAMPLES } from './spam-comments';

const cases = [
	{ id: 1, falsePositive: 'They asked me to pay a delivery fee. Is that a scam?', ordinary: 'The shipping calculation needs a correction.', miss: 'Pay the delivery fee to claim it.' },
	{ id: 2, falsePositive: 'Please stop posting sub4sub.', ordinary: 'I subscribed because this tutorial helped.', miss: 'Sub for sub? Visit my channel.' },
	{ id: 3, falsePositive: 'The source is https://example.invalid/reference', ordinary: 'The source is in the description.', miss: 'Claim at example.invalid/prize' },
	{ id: 4, falsePositive: 'Our public support contact is WhatsApp: +1 202 555 0147.', ordinary: 'The calculation at 4:12 should use 2026 prices.', miss: 'Send a message to collect your prize.' }
];

test.each(cases)('displayed rule $id holds its synthetic example and a legitimate matching comment', ({ id, falsePositive }) => {
	const rule = SPAM_RULE_EXAMPLES.find((candidate) => candidate.id === id)!;
	const prepared = prepareRules([rule]);
	for (const text of [rule.example, falsePositive]) {
		expect(matchPreparedRule(text, 'synthetic-author', prepared)).toEqual(rule);
		expect(matchPreparedRule(text, 'synthetic-author', prepared)?.action).toBe('hold');
	}
});

test.each(cases)('displayed rule $id leaves its ordinary negative control and known miss unmatched', ({ id, ordinary, miss }) => {
	const rule = SPAM_RULE_EXAMPLES.find((candidate) => candidate.id === id)!;
	const prepared = prepareRules([rule]);
	for (const text of [ordinary, miss]) expect(matchPreparedRule(text, 'synthetic-author', prepared)).toBeNull();
});

test('combined educational rules expose an overlapping link-and-phone match without changing the engine', () => {
	const prepared = prepareRules([...SPAM_RULE_EXAMPLES]);
	const match = matchPreparedRule('Contact Telegram: +1 202 555 0147 at https://example.invalid/prize', 'synthetic-author', prepared);
	expect(match).toEqual(SPAM_RULE_EXAMPLES[3]);
});
