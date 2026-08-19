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
// Computes the Stryker --mutate scope for PR-scale runs: the src files that
// changed vs a base ref, filtered to the same set as the mutate globs in
// stryker.config.json. Shared by .github/workflows/mutation.yml and the
// documented local commands so the two cannot drift. Passing --mutate on
// the CLI OVERRIDES the config's mutate globs, so this filter — not the
// config — decides what gets mutated; keep it in sync with stryker.config.json.
//
// Prints a comma-separated scope on stdout. An empty line means nothing
// mutable changed — callers must skip the Stryker run rather than pass an
// empty --mutate.
//
// Usage:
//   node scripts/stryker-pr-scope.mjs [base-ref]   # base-ref defaults to main
// Example:
//   SCOPE=$(node scripts/stryker-pr-scope.mjs) && \
//     npx stryker run --mutate "$SCOPE"

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Mirrors the exclusions in stryker.config.json's mutate globs.
const EXCLUDED_FILES = new Set([
	'src/lib/server/testuser.ts',
	'src/lib/auto-refresh.svelte.ts',
	'src/routes/terms/+page.ts',
	'src/routes/privacy/+page.ts',
	'src/routes/dpa/+page.ts'
]);

export function scopeFromChangedFiles(files) {
	return files
		.filter((f) => /^src\/.+\.ts$/.test(f))
		.filter((f) => !f.endsWith('.test.ts'))
		.filter((f) => !EXCLUDED_FILES.has(f))
		.join(',');
}

async function changedFiles(base) {
	const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${base}...HEAD`]);
	return stdout.split('\n').filter((line) => line.length > 0);
}

// Filesystem-path comparison: building a URL from argv[1] by string
// interpolation breaks on paths needing encoding ('#', spaces), silently
// disabling the main block.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
	const base = process.argv[2] ?? 'main';
	const scope = scopeFromChangedFiles(await changedFiles(base));
	console.log(scope);
}
