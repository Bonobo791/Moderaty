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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

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
