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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

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
