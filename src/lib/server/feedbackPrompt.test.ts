import { describe, expect, test } from 'vitest';
import { FEEDBACK_CATEGORIES, FEEDBACK_PROMPT, buildFeedbackPrompt } from './feedbackPrompt';

describe('feedback taxonomy rubric', () => {
	test('exposes exactly the five stable category values', () => {
		// The digest groups on these values — adding or renaming one without
		// updating the schema/UI/tests breaks the contract, so pin it.
		expect(FEEDBACK_CATEGORIES).toEqual(['question', 'criticism', 'correction', 'request', 'none']);
	});

	test('the prompt names every category value exactly once in the JSON contract', () => {
		for (const category of FEEDBACK_CATEGORIES) {
			expect(FEEDBACK_PROMPT).toContain(`"${category}"`);
		}
		expect(FEEDBACK_PROMPT).toContain('"hasAbuse"');
		expect(FEEDBACK_PROMPT).toContain('"claim"');
	});

	test('the rubric forbids abuse inside the extracted claim', () => {
		expect(FEEDBACK_PROMPT).toContain('Extract the safe claim, never the abuse');
	});

	test('buildFeedbackPrompt returns the rubric', () => {
		expect(buildFeedbackPrompt()).toBe(FEEDBACK_PROMPT);
	});
});
