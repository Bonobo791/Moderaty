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

import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		environment: 'node',
		// The fast-check property suite (`safeRegexArb always passes validateRule`
		// and friends) runs ~2s isolated but can exceed vitest's 5s default under
		// full-suite parallel CPU load — raised so a slow-but-correct property run
		// is never misreported as a failure (a hung test still fails, at 30s).
		testTimeout: 30_000,
		// Local git worktrees (e.g. parallel agent work) run their own suites.
		// .stryker-tmp holds Stryker's in-flight sandbox (a full project copy,
		// tests included) — exclude it or a concurrent Stryker run makes vitest
		// execute every test twice (128 files instead of 64).
		exclude: ['**/node_modules/**', '**/.worktrees/**', '**/.stryker-tmp/**']
	}
});
