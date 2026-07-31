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

import { scoreTone } from './tone';

const CONTEXT = { videoTitle: 'My video', videoDescription: 'A video about things' };

function chatResponse(content: string, status = 200) {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test('returns the tone score and sends context, model, and the calibrated rubric', async () => {
	const fetch = vi.fn().mockResolvedValue(chatResponse('{"score": 0.82}'));
	vi.stubGlobal('fetch', fetch);

	const result = await scoreTone('nice video, genius', CONTEXT);

	expect(result).toEqual({ score: 0.82 });
	const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
	expect(body.model).toBe('gpt-4.1-nano');
	expect(body.temperature).toBe(0);
	expect(body.response_format).toEqual({ type: 'json_object' });
	const prompt = body.messages.map((message: { content: string }) => message.content).join('\n');
	expect(prompt).toContain('My video');
	expect(prompt).toContain('A video about things');
	expect(prompt).toContain('nice video, genius');
	// The calibrated bands must be part of the prompt contract so the model
	// stays conservative (0.95+ reserved for genuine harm without verbal abuse).
	expect(prompt).toContain('0.95');
	expect(prompt).toMatch(/reserved|rare/i);
});

test('fails loudly when the chat request fails', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 })));

	await expect(scoreTone('text', CONTEXT)).rejects.toThrow('tone failed: 403');
});

test('fails loudly when the chat response is not JSON', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));

	await expect(scoreTone('text', CONTEXT)).rejects.toThrow('tone returned invalid JSON');
});

test.each([
	['non-JSON message content', chatResponse('sorry, I cannot help')],
	['a missing score', chatResponse('{"verdict": "mean"}')],
	['a string score', chatResponse('{"score": "high"}')],
	['an above-range score', chatResponse('{"score": 2}')],
	['a below-range score', chatResponse('{"score": -0.5}')],
	['no choices', new Response(JSON.stringify({ choices: [] }), { status: 200 })]
])('rejects a tone response with %s', async (_label, response) => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

	await expect(scoreTone('text', CONTEXT)).rejects.toThrow('tone response has missing or out-of-range score');
});
