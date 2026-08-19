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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
	test('prefers a custom SOURCE_COMMIT_SHA over everything (legacy/custom setups)', () => {
		expect(resolveCommit({ SOURCE_COMMIT_SHA: 'abc123', SOURCE_COMMIT: 'cdef', COMMIT_REF: 'def456' })).toBe('abc123');
	});

	test('uses Coolify\'s real build-time variable SOURCE_COMMIT', () => {
		// Coolify passes the deployed commit as SOURCE_COMMIT (its predefined
		// build variable) — as a BuildKit secret with "Use Docker Build
		// Secrets" on, or as --build-arg SOURCE_COMMIT otherwise.
		expect(resolveCommit({ SOURCE_COMMIT: 'c0ffee'.padEnd(40, '0'), COMMIT_REF: 'def456' })).toBe('c0ffee'.padEnd(40, '0'));
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

describe('resolveCommit without a git subprocess (S4036)', () => {
	// A synthetic repo root: resolveCommit must read HEAD straight from .git —
	// the old `git rev-parse HEAD` implementation ignored the root and spawned
	// git in the test process cwd, so these all fail against the real repo.
	const SHA = 'a'.repeat(40);

	test('reads HEAD from a plain repo .git (branch ref)', () => {
		const root = mkdtempSync(join(tmpdir(), 'moderaty-git-plain-'));
		tempDirs.push(root);
		mkdirSync(join(root, '.git/refs/heads'), { recursive: true });
		writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
		writeFileSync(join(root, '.git/refs/heads/main'), SHA + '\n');
		expect(resolveCommit({}, root)).toBe(SHA);
	});

	test('reads HEAD through a worktree .git gitdir file', () => {
		const root = mkdtempSync(join(tmpdir(), 'moderaty-git-wt-'));
		tempDirs.push(root);
		const gitDir = join(root, 'actual-git');
		mkdirSync(join(gitDir, 'refs/heads'), { recursive: true });
		writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`);
		writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/dev\n');
		writeFileSync(join(gitDir, 'refs/heads/dev'), SHA + '\n');
		expect(resolveCommit({}, root)).toBe(SHA);
	});

	test('reads a detached HEAD SHA', () => {
		const root = mkdtempSync(join(tmpdir(), 'moderaty-git-detached-'));
		tempDirs.push(root);
		mkdirSync(join(root, '.git'), { recursive: true });
		writeFileSync(join(root, '.git/HEAD'), SHA + '\n');
		expect(resolveCommit({}, root)).toBe(SHA);
	});

	test('reads a packed ref when the loose ref file is absent', () => {
		const root = mkdtempSync(join(tmpdir(), 'moderaty-git-packed-'));
		tempDirs.push(root);
		mkdirSync(join(root, '.git'), { recursive: true });
		writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
		writeFileSync(join(root, '.git/packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n`);
		expect(resolveCommit({}, root)).toBe(SHA);
	});

	test("returns 'unknown' when the root has no .git instead of resolving git from PATH", () => {
		const root = mkdtempSync(join(tmpdir(), 'moderaty-git-none-'));
		tempDirs.push(root);
		expect(resolveCommit({}, root)).toBe('unknown');
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
