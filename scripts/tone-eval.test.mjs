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
