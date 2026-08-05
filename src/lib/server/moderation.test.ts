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

const BASE_SCORES = {
	harassment: 0.11,
	'harassment/threatening': 0.22,
	hate: 0.33,
	'hate/threatening': 0.44,
	illicit: 0.05,
	'illicit/violent': 0.06,
	'self-harm': 0.07,
	'self-harm/intent': 0.08,
	'self-harm/instructions': 0.09,
	sexual: 0.1,
	'sexual/minors': 0.01,
	violence: 0.55,
	'violence/graphic': 0.91
};

const LOW_SCORES = Object.fromEntries(Object.keys(BASE_SCORES).map((category) => [category, 0.01]));

function mockScores(overrides: Record<string, number> = {}) {
	return { ...BASE_SCORES, ...overrides };
}

function stubScores(categoryScores: Record<string, number>) {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
		results: [{ category_scores: categoryScores }]
	}), { status: 200 })));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test('returns the maximum score across all moderation categories, including sexual', async () => {
	const scores = mockScores({ sexual: 0.95 });
	stubScores(scores);

	const result = await scoreComment('comment text');

	expect(result.scores).toEqual(scores);
	expect(result.score).toBe(0.95);
});

test.each([
	['sexual', 0.95],
	['self-harm', 0.9],
	['illicit', 0.88]
])('treats %s as a scored category (%f wins the max)', async (category, categoryScore) => {
	stubScores({ ...LOW_SCORES, [category]: categoryScore });

	const result = await scoreComment('comment text');

	expect(result.score).toBe(categoryScore);
});

test.each([
	['above range', 2],
	['below range', -0.5]
])('rejects a category score %s (%f)', async (_label, badScore) => {
	stubScores(mockScores({ violence: badScore }));

	await expect(scoreComment('comment text')).rejects.toThrow('out-of-range');
});

test('rejects a response missing a required category score', async () => {
	stubScores({
		harassment: 0.11,
		'harassment/threatening': 0.22,
		hate: 0.33,
		'hate/threatening': 0.44,
		violence: 0.55,
		'violence/graphic': 0.91
	});

	await expect(scoreComment('comment text')).rejects.toThrow('missing or out-of-range');
});

test('an explicit apiKey overrides the env key in the Authorization header', async () => {
	const fetch = vi.fn().mockResolvedValue(
		new Response(JSON.stringify({ results: [{ category_scores: mockScores() }] }), { status: 200 })
	);
	vi.stubGlobal('fetch', fetch);

	await scoreComment('comment text', undefined, 'sk-org-key');

	expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer sk-org-key' });
});

test('the env key is the default when no explicit key is passed', async () => {
	const fetch = vi.fn().mockResolvedValue(
		new Response(JSON.stringify({ results: [{ category_scores: mockScores() }] }), { status: 200 })
	);
	vi.stubGlobal('fetch', fetch);

	await scoreComment('comment text');

	expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer test-openai-key' });
});
