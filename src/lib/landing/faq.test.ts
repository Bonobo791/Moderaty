// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

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
