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

// The scope filter must mirror the mutate globs in stryker.config.json:
// passing --mutate on the CLI OVERRIDES the config, so any file the filter
// lets through gets mutated even if the config excludes it (PR #103 review).

import { describe, expect, it } from 'vitest';

import { scopeFromChangedFiles } from './stryker-pr-scope.mjs';

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
