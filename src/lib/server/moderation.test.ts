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

import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { OPENAI_API_KEY: 'test-openai-key' }
}));

import { scoreComment } from './moderation';

afterEach(() => {
	vi.unstubAllGlobals();
});

test('returns the maximum score across all toxic categories', async () => {
	const scores = {
		harassment: 0.11,
		'harassment/threatening': 0.22,
		hate: 0.33,
		'hate/threatening': 0.44,
		violence: 0.55,
		'violence/graphic': 0.91
	};
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
		results: [{ category_scores: scores }]
	}), { status: 200 })));

	const result = await scoreComment('comment text');

	expect(result.scores).toEqual(scores);
	expect(result.score).toBe(0.91);
});
