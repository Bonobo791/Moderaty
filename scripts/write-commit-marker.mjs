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

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER_FILE = '__moderaty_commit.txt';

/**
 * Resolves the commit this build is deploying.
 *
 * @param env - The environment (defaults to process.env)
 * @returns The full commit SHA, or 'unknown' when no provider variable exists and git is unavailable
 */
export function resolveCommit(env = process.env) {
	// Full SHAs from the deploy platforms (both are 40-char; never truncate —
	// the workflow compares against $GITHUB_SHA verbatim).
	if (env.SOURCE_COMMIT_SHA) return env.SOURCE_COMMIT_SHA;
	if (env.SOURCE_COMMIT) return env.SOURCE_COMMIT;
	if (env.COMMIT_REF) return env.COMMIT_REF;
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
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
