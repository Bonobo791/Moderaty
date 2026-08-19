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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveCommit, writeCommitMarker } from './write-commit-marker.mjs';

const tempDirs = [];

function tempStaticDir() {
	const dir = mkdtempSync(join(tmpdir(), 'moderaty-marker-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveCommit', () => {
	test('prefers the Coolify SOURCE_COMMIT_SHA over everything', () => {
		expect(resolveCommit({ SOURCE_COMMIT_SHA: 'abc123', COMMIT_REF: 'def456' })).toBe('abc123');
	});

	test('falls back to the Netlify COMMIT_REF', () => {
		expect(resolveCommit({ COMMIT_REF: 'def456' })).toBe('def456');
	});

	test('falls back to git rev-parse HEAD (full sha) when no provider variable is set', () => {
		const sha = resolveCommit({});
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
	});

	test('never falls back silently to a truncated or empty value', () => {
		expect(resolveCommit({})).not.toBe('');
	});
});

describe('writeCommitMarker', () => {
	test('writes the marker file with the full commit', () => {
		const dir = tempStaticDir();
		writeCommitMarker(dir, '0123456789abcdef0123456789abcdef01234567');
		expect(readFileSync(join(dir, '__moderaty_commit.txt'), 'utf8')).toBe('0123456789abcdef0123456789abcdef01234567');
	});

	test('creates the directory when missing', () => {
		const dir = join(tempStaticDir(), 'nested', 'static');
		writeCommitMarker(dir, 'sha');
		expect(readFileSync(join(dir, '__moderaty_commit.txt'), 'utf8')).toBe('sha');
	});
});
