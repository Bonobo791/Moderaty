import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('ESLint uses the supported runtime and an isolated tool installation', () => {
	const workflow = readFileSync(new URL('../.github/workflows/eslint.yml', import.meta.url), 'utf8');
	expect(workflow).toContain("node-version: '24.19.0'");
	expect(workflow).toContain('--prefix "$RUNNER_TEMP/moderaty-eslint" --ignore-scripts');
	expect(workflow).not.toContain('--config .eslintrc.js');
	expect(workflow).not.toContain('continue-on-error: true');
});

test('the duplicate advanced CodeQL workflow does not conflict with active default setup', () => {
	expect(existsSync(new URL('../.github/workflows/codeql.yml', import.meta.url))).toBe(false);
});
