// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

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
