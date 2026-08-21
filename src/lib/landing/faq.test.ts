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
