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

// The scope filter must mirror the mutate globs in stryker.config.json:
// passing --mutate on the CLI OVERRIDES the config, so any file the filter
// lets through gets mutated even if the config excludes it (PR #103 review).

import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { scopeFromChangedFiles } from './stryker-pr-scope.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('scopeFromChangedFiles', () => {
	it('keeps production TypeScript under src', () => {
		expect(scopeFromChangedFiles(['src/lib/server/pipeline.ts'])).toBe('src/lib/server/pipeline.ts');
		expect(scopeFromChangedFiles(['src/hooks.server.ts'])).toBe('src/hooks.server.ts');
	});

	it('drops test files anywhere under src', () => {
		expect(scopeFromChangedFiles(['src/lib/server/pipeline.test.ts'])).toBe('');
		expect(scopeFromChangedFiles(['src/routes/api/auth/google/oauth.test.ts'])).toBe('');
	});

	it('drops the dev-seed helper and the static legal page loaders', () => {
		expect(scopeFromChangedFiles(['src/lib/server/testuser.ts'])).toBe('');
		expect(scopeFromChangedFiles(['src/routes/terms/+page.ts'])).toBe('');
		expect(scopeFromChangedFiles(['src/routes/privacy/+page.ts'])).toBe('');
		expect(scopeFromChangedFiles(['src/routes/dpa/+page.ts'])).toBe('');
	});

	it('drops the SSR-untestable $effect wrapper', () => {
		expect(scopeFromChangedFiles(['src/lib/auto-refresh.svelte.ts'])).toBe('');
	});

	it('drops files outside src and non-TypeScript files', () => {
		expect(scopeFromChangedFiles(['AGENTS.md'])).toBe('');
		expect(scopeFromChangedFiles(['.github/workflows/mutation.yml'])).toBe('');
		expect(scopeFromChangedFiles(['src/app.css'])).toBe('');
		expect(scopeFromChangedFiles(['scripts/stryker-pr-scope.mjs'])).toBe('');
	});

	it('joins a mixed diff into a comma-separated scope', () => {
		expect(
			scopeFromChangedFiles([
				'AGENTS.md',
				'src/lib/server/org.ts',
				'src/lib/server/org.test.ts',
				'src/lib/relative-time.ts'
			])
		).toBe('src/lib/server/org.ts,src/lib/relative-time.ts');
	});

	it('returns an empty scope for empty or fully-filtered diffs', () => {
		expect(scopeFromChangedFiles([])).toBe('');
		expect(scopeFromChangedFiles(['src/routes/terms/+page.ts', 'README.md'])).toBe('');
	});
});

describe('CLI entry point', () => {
	it('prints the scope when invoked with a relative path, as documented', async () => {
		const { stdout: diff } = await execFileAsync('git', ['diff', '--name-only', 'HEAD~5...HEAD'], {
			cwd: repoRoot
		});
		const expected = scopeFromChangedFiles(diff.split('\n').filter((line) => line.length > 0));

		const { stdout } = await execFileAsync('node', ['scripts/stryker-pr-scope.mjs', 'HEAD~5'], {
			cwd: repoRoot
		});

		expect(stdout).toBe(`${expected}\n`);
	});

	it('prints the scope even when its own path breaks naive URL construction', async () => {
		// PR #103 review: the entry-point check compared import.meta.url against
		// new URL(`file://${process.argv[1]}`) — a path containing '#' makes that
		// URL parse the rest as a fragment, so the comparison failed and the
		// script silently printed nothing.
		const dir = mkdtempSync(join(tmpdir(), 'mt-scope-#'));
		try {
			const scriptPath = join(dir, 'stryker-pr-scope.mjs');
			copyFileSync(fileURLToPath(new URL('./stryker-pr-scope.mjs', import.meta.url)), scriptPath);

			const { stdout: diff } = await execFileAsync('git', ['diff', '--name-only', 'HEAD~5...HEAD'], {
				cwd: repoRoot
			});
			const expected = scopeFromChangedFiles(diff.split('\n').filter((line) => line.length > 0));

			const { stdout } = await execFileAsync('node', [scriptPath, 'HEAD~5'], { cwd: repoRoot });

			expect(stdout).toBe(`${expected}\n`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
