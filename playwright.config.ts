import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.pw.ts',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	outputDir: 'reports/playwright-results',
	reporter: [['list'], ['html', { outputFolder: 'reports/playwright', open: 'never' }]],
	use: {
		...devices['Desktop Chrome'], trace: 'retain-on-failure', screenshot: 'only-on-failure',
		launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
			? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
			: undefined
	}
});
