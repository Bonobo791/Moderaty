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

import { expect, test } from 'vitest';
import { matchRule } from './rules';

test('matches keyword, user ID, and regex rules', () => {
	const keyword = { id: 1, type: 'keyword', pattern: 'spam', action: 'hold' };
	const user = { id: 2, type: 'user', pattern: 'UC-author', action: 'reject' };
	const regex = { id: 3, type: 'regex', pattern: 'buy\\s+now', action: 'delete' };

	expect(matchRule('This is SPAM', 'other', [keyword])).toBe(keyword);
	expect(matchRule('A normal comment', 'UC-author', [user])).toBe(user);
	expect(matchRule('BUY now!', 'other', [regex])).toBe(regex);
	expect(matchRule('A normal comment', 'other', [keyword, user, regex])).toBeNull();
});

test('rejects invalid stored rules', () => {
	expect(() => matchRule('text', 'author', [{ id: 2, type: 'regex', pattern: '(', action: 'hold' }])).toThrow(
		/rule #2 has an invalid regex/
	);
	expect(() => matchRule('text', 'author', [{ id: 3, type: 'unknown', pattern: 'text', action: 'hold' }])).toThrow(
		/rule #3 has an unsupported type/
	);
	expect(() => matchRule('text', 'author', [{ id: 4, type: 'keyword', pattern: 'text', action: 'archive' }])).toThrow(
		/rule #4 has an unsupported action/
	);
	expect(() => matchRule('text', 'author', [{ id: 5, type: 'regex', pattern: '^(a+)+$', action: 'hold' }])).toThrow(
		/rule #5 has an unsafe regex/
	);
	expect(() => matchRule('aa', 'author', [{ id: 6, type: 'regex', pattern: '(?<word>a+)\\k<word>', action: 'hold' }])).toThrow(
		/rule #6 has an unsafe regex/
	);
});
