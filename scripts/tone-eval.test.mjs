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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { TONE_PROMPT } from '../src/lib/server/tonePrompt.js';
import { loadEnvIfPresent } from './tone-eval.mjs';

const dirs = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	delete process.env.TONE_EVAL_TEST_A;
	delete process.env.TONE_EVAL_TEST_B;
});

function envDir(contents) {
	const dir = mkdtempSync(join(tmpdir(), 'tone-eval-'));
	dirs.push(dir);
	if (contents !== undefined) writeFileSync(join(dir, '.env'), contents);
	return dir;
}

test('a missing .env is not an error when the key comes from the environment', () => {
	// PR #24 review: the harness must run in CI/shell setups that inject secrets
	// via env vars only — .env is optional, never required.
	expect(loadEnvIfPresent(envDir())).toBe(false);
});

test('.env values strip unquoted inline comments, keep quoted #, and trim whitespace', () => {
	// PR #24 review: naive parsing used to swallow trailing comments into the
	// API key; use Node's built-in parser semantics instead.
	const dir = envDir('TONE_EVAL_TEST_A=sk-plain # trailing note\nTONE_EVAL_TEST_B="sk-quoted # keep"  \n');

	expect(loadEnvIfPresent(dir)).toBe(true);
	expect(process.env.TONE_EVAL_TEST_A).toBe('sk-plain');
	expect(process.env.TONE_EVAL_TEST_B).toBe('sk-quoted # keep');
});

test('the tone rubric lives in one shared module imported by both tone.ts and the eval script', () => {
	// PR #24 review: regex-extracting the prompt from tone.ts source can silently
	// truncate on an escaped backtick. A shared module is the single source of
	// truth — no source parsing, no copy-paste.
	expect(TONE_PROMPT).toContain('0.76-0.94');
	expect(TONE_PROMPT).toContain('lol are you kidding? This is it? Not a great video.');
	const toneSource = readFileSync(new URL('../src/lib/server/tone.ts', import.meta.url), 'utf8');
	expect(toneSource).toMatch(/import \{ TONE_PROMPT \} from '\$lib\/server\/tonePrompt'/);
	expect(toneSource).not.toContain('const TONE_PROMPT');
	const scriptSource = readFileSync(new URL('./tone-eval.mjs', import.meta.url), 'utf8');
	expect(scriptSource).toMatch(/from '\.\.\/src\/lib\/server\/tonePrompt\.js'/);
	expect(scriptSource).not.toContain('const TONE_PROMPT = `');
});

test('scoffing interjections are judged against the video context', () => {
	// A bare "lol" is demeaning on ordinary content but a normal reaction on a
	// comedy video; a bare "what?" is demeaning unless the video shows something
	// genuinely odd or surprising. The rubric must say so, with calibration
	// anchors covering both directions.
	expect(TONE_PROMPT).toMatch(/comedy|funny/i);
	expect(TONE_PROMPT).toMatch(/odd or surprising|surprising|odd/i);
	const lolOnTutorial = TONE_PROMPT.match(/"lol"[^\n]*tutorial[^\n]*->\s*(0\.\d+)/i);
	const lolOnComedy = TONE_PROMPT.match(/"lol"[^\n]*comedy[^\n]*->\s*(0\.\d+)/i);
	expect(lolOnTutorial).toBeTruthy();
	expect(lolOnComedy).toBeTruthy();
	// Same word, opposite bands: demeaning on a tutorial, acceptable on comedy.
	expect(Number(lolOnTutorial?.[1])).toBeGreaterThanOrEqual(0.76);
	expect(Number(lolOnComedy?.[1])).toBeLessThanOrEqual(0.5);
	// PR #27 review: assert the "what?" anchors too, so they cannot regress
	// silently — demeaning on an ordinary video, acceptable on a surprising one.
	const whatOnHowto = TONE_PROMPT.match(/"what\?"[^\n]*how-to[^\n]*->\s*(0\.\d+)/i);
	const whatOnSurprising = TONE_PROMPT.match(/"what\?"[^\n]*surprising[^\n]*->\s*(0\.\d+)/i);
	expect(whatOnHowto).toBeTruthy();
	expect(whatOnSurprising).toBeTruthy();
	expect(Number(whatOnHowto?.[1])).toBeGreaterThanOrEqual(0.76);
	expect(Number(whatOnSurprising?.[1])).toBeLessThanOrEqual(0.5);
});

test('the contextual exemption requires evidence — empty context means ordinary content', () => {
	// PR #27 review: production sends empty title/description for comments
	// without a videoId or after metadata failure. Without an explicit policy
	// the model would guess whether the content is comedic or surprising and
	// score the same bare interjection inconsistently. The rubric must say the
	// exemption applies only on affirmative evidence, and anchor it.
	expect(TONE_PROMPT).toMatch(/empty|missing|no (such )?(signal|context|evidence)/i);
	expect(TONE_PROMPT).toMatch(/treat (the content|it) as ordinary/i);
	const lolNoContext = TONE_PROMPT.match(/"lol"[^\n]*(?:no video context|unknown context)[^\n]*->\s*(0\.\d+)/i);
	expect(lolNoContext).toBeTruthy();
	expect(Number(lolNoContext?.[1])).toBeGreaterThanOrEqual(0.76);
});

test('condescending bare contradiction is demeaning; constructive correction stays acceptable', () => {
	// The "actually..." crowd: comments that exist only to contradict and talk
	// down, with no substantive engagement, belong in the demeaning band. A
	// correction that adds constructive content stays acceptable even with a
	// pedantic opener. The rubric must say so and anchor both directions.
	expect(TONE_PROMPT).toMatch(/bare contradiction|contradict|pedantic/i);
	const bareActually = TONE_PROMPT.match(/"Actually, that's not correct\."[^\n]*->\s*(0\.\d+)/i);
	const constructive = TONE_PROMPT.match(/"Actually,[^\n"]*(?:ft-lb|torque|manual)[^\n"]*"[^\n]*->\s*(0\.\d+)/i);
	expect(bareActually).toBeTruthy();
	expect(constructive).toBeTruthy();
	expect(Number(bareActually?.[1])).toBeGreaterThanOrEqual(0.76);
	expect(Number(constructive?.[1])).toBeLessThanOrEqual(0.5);
});
