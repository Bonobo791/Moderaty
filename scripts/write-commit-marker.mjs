#!/usr/bin/env node
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
//
// Writes the deployed commit SHA to static/__moderaty_commit.txt at BUILD
// time, so the bunny-purge workflow can wait for the deployment to actually
// serve the pushed commit BEFORE purging the CDN (codex review: a purge that
// races the deploy purges the OLD origin, and the new deploy never purges —
// production stays stale until the TTL).
//
// The marker is a static asset: both the Netlify and adapter-node builds copy
// static/ into the deployable output, and the file is served at
// /__moderaty_commit.txt. Deploy platforms inject the commit:
//   - Coolify: SOURCE_COMMIT (Coolify's predefined build-time variable; the
//     Dockerfile exposes it to this script either as a BuildKit secret mount
//     — "Use Docker Build Secrets" on — or via ARG/--build-arg otherwise).
//   - Netlify: COMMIT_REF (build environment)
//   - local/other: git rev-parse HEAD, falling back to 'unknown' (the purge
//     wait simply times out and purges anyway — best effort, never silent).
// SOURCE_COMMIT_SHA is kept only as a legacy/custom fallback — Coolify has
// never defined that name.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER_FILE = '__moderaty_commit.txt';

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Reads the HEAD commit straight from the repository's .git directory — no
 * `git` subprocess (S4036: OS commands must not rely on PATH resolution).
 * Handles plain repos (.git dir), worktrees (.git file with `gitdir: …`),
 * branch refs, detached HEAD, and packed refs. Any failure returns 'unknown'.
 *
 * @param root - The repository root (must contain .git)
 * @returns The full commit SHA, or 'unknown'
 */
/**
 * Resolves the repository's git directory, following a worktree `.git` FILE
 * (`gitdir: <path>`) when present.
 *
 * @param root - Repository root
 * @returns The git dir path, or null when `.git` is unreadable/malformed
 */
function gitDirFor(root) {
	const dotGit = resolve(root, '.git');
	if (existsSync(resolve(dotGit, 'HEAD'))) return dotGit;
	// A worktree/submodule `.git` is a FILE: `gitdir: <path>`. Parse the line
	// directly instead of with `\s*(.+)` (sonarcloud: super-linear backtracking).
	const line = readFileSync(dotGit, 'utf8').split('\n').find((candidate) => candidate.startsWith('gitdir:'));
	if (!line) return null;
	return resolve(dirname(dotGit), line.slice('gitdir:'.length).trim());
}

/**
 * Resolves the directory holding branch refs: worktrees keep them in the
 * COMMON git dir, reached via the `commondir` redirect.
 *
 * @param gitDir - The (worktree) git directory
 * @returns The refs base directory (gitDir itself when no redirect exists)
 */
function refsBaseFor(gitDir) {
	const commonFile = resolve(gitDir, 'commondir');
	if (!existsSync(commonFile)) return gitDir;
	return resolve(gitDir, readFileSync(commonFile, 'utf8').trim());
}

/**
 * Reads the commit SHA for a ref from the loose ref file, then packed-refs.
 *
 * @param refsBase - The refs base directory
 * @param ref - The ref name (e.g. refs/heads/main)
 * @returns The full commit SHA, or null when the ref is absent
 */
function commitForRef(refsBase, ref) {
	const refPath = resolve(refsBase, ref);
	if (existsSync(refPath)) {
		const sha = readFileSync(refPath, 'utf8').trim();
		if (COMMIT_SHA_RE.test(sha)) return sha;
	}
	const packed = resolve(refsBase, 'packed-refs');
	if (!existsSync(packed)) return null;
	for (const line of readFileSync(packed, 'utf8').split(/\r?\n/)) {
		const match = line.match(/^([0-9a-f]{40})\s+(\S+)$/);
		if (match && match[2] === ref) return match[1];
	}
	return null;
}

export function readGitHeadCommit(root) {
	try {
		const gitDir = gitDirFor(root);
		if (!gitDir) return 'unknown';
		const head = readFileSync(resolve(gitDir, 'HEAD'), 'utf8').trim();
		const ref = head.match(/^ref:\s*(.+)$/)?.[1]?.trim();
		if (ref) return commitForRef(refsBaseFor(gitDir), ref) ?? 'unknown';
		return COMMIT_SHA_RE.test(head) ? head : 'unknown';
	} catch {
		return 'unknown';
	}
}

export function resolveCommit(env = process.env, root = process.cwd()) {
	// Full SHAs from the deploy platforms (both are 40-char; never truncate —
	// the workflow compares against $GITHUB_SHA verbatim).
	if (env.SOURCE_COMMIT_SHA) return env.SOURCE_COMMIT_SHA;
	if (env.SOURCE_COMMIT) return env.SOURCE_COMMIT;
	if (env.COMMIT_REF) return env.COMMIT_REF;
	return readGitHeadCommit(root);
}

/**
 * Writes the commit marker into a static asset directory.
 *
 * @param staticDir - The static/ directory to write into (created if missing)
 * @param commit - The commit SHA to record
 */
export function writeCommitMarker(staticDir, commit) {
	mkdirSync(staticDir, { recursive: true });
	writeFileSync(join(staticDir, MARKER_FILE), commit);
}

// Only run when executed directly (not when imported by tests) — same
// normalized-path guard as scripts/bunny-purge.mjs.
const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
	writeCommitMarker(join(dirname(fileURLToPath(import.meta.url)), '..', 'static'), resolveCommit());
}
