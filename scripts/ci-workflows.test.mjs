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

test('AgentShield CI installs the pinned scanner before running the reviewed repository gate', () => {
	const workflow = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
	const job = workflow.split('  agentshield:\n')[1]?.split('\n  validate:')[0];
	expect(job).toBeDefined();
	expect(job).toMatch(/node-version: '24\.19\.0'[\s\S]*run: npm ci --ignore-scripts[\s\S]*run: npm run scan:agents/);
	expect(job).not.toContain('uses: affaan-m/agentshield');
	expect(job).not.toContain('continue-on-error:');
});
