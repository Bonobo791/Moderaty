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
