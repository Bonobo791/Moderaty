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

// @ts-nocheck

import assert from 'node:assert/strict';
import test from 'node:test';
import { matchRule } from './rules.js';

test('matches valid rules and rejects invalid stored rules', () => {
	const rule = { id: 1, type: 'keyword', pattern: 'spam', action: 'hold' };
	assert.equal(matchRule('This is spam', 'author', [rule]), rule);
	assert.throws(
		() => matchRule('text', 'author', [{ id: 2, type: 'regex', pattern: '(', action: 'hold' }]),
		/rule #2 has an invalid regex/
	);
	assert.throws(
		() => matchRule('text', 'author', [{ id: 3, type: 'unknown', pattern: 'text', action: 'hold' }]),
		/rule #3 has an unsupported type/
	);
	assert.throws(
		() => matchRule('text', 'author', [{ id: 4, type: 'keyword', pattern: 'text', action: 'archive' }]),
		/rule #4 has an unsupported action/
	);
});
