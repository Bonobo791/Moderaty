#!/usr/bin/env node
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
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Mirrors the exclusions in stryker.config.json's mutate globs.
const EXCLUDED_FILES = new Set([
	'src/lib/server/testuser.ts',
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

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
	const base = process.argv[2] ?? 'main';
	const scope = scopeFromChangedFiles(await changedFiles(base));
	console.log(scope);
}
