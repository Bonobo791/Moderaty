import { expect, test } from 'vitest';

import {
	LGBTQIA_PROTECTION_SECTION,
	TONE_PROMPT,
	WOMEN_PROTECTION_SECTION,
	buildTonePrompt
} from './tonePrompt.js';

test('buildTonePrompt with no protections returns exactly TONE_PROMPT', () => {
	// Byte-identical: the live calibration of the base rubric must never drift
	// when protections are off.
	expect(buildTonePrompt()).toBe(TONE_PROMPT);
	expect(buildTonePrompt({})).toBe(TONE_PROMPT);
	expect(buildTonePrompt({ protectLgbtqia: 0, protectWomen: 0 })).toBe(TONE_PROMPT);
	expect(buildTonePrompt({ protectLgbtqia: null, protectWomen: null })).toBe(TONE_PROMPT);
});

test('buildTonePrompt appends only the enabled protection sections', () => {
	expect(buildTonePrompt({ protectLgbtqia: 1 })).toBe(`${TONE_PROMPT}\n\n${LGBTQIA_PROTECTION_SECTION}`);
	expect(buildTonePrompt({ protectWomen: 1 })).toBe(`${TONE_PROMPT}\n\n${WOMEN_PROTECTION_SECTION}`);
	expect(buildTonePrompt({ protectLgbtqia: 1, protectWomen: 1 })).toBe(
		`${TONE_PROMPT}\n\n${LGBTQIA_PROTECTION_SECTION}\n\n${WOMEN_PROTECTION_SECTION}`
	);
	// A disabled section must never leak in through the other flag.
	expect(buildTonePrompt({ protectLgbtqia: 1 })).not.toContain(WOMEN_PROTECTION_SECTION);
	expect(buildTonePrompt({ protectWomen: 1 })).not.toContain(LGBTQIA_PROTECTION_SECTION);
});
