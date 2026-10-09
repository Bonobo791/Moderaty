import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');

function branchesFor(event) {
	const match = [...workflow.matchAll(/^  (push|pull_request):\n    branches: \[([^\]\n]+)\]$/gm)]
		.find((match) => match[1] === event);
	const list = match?.[2];
	expect(list, `${event} must have an explicit branch list`).toBeDefined();
	return list.split(',').map((branch) => branch.trim().replace(/^['"]|['"]$/g, ''));
}

test('validates direct pushes and pull requests on both long-lived branches', () => {
	for (const event of ['push', 'pull_request']) {
		expect(branchesFor(event)).toEqual(expect.arrayContaining(['dev', 'main']));
	}
});

test('installs dependencies without automatically running package lifecycle scripts', () => {
	const installs = [...workflow.matchAll(/^\s+- run: (npm ci[^\n]*)$/gm)].map((match) => match[1]);
	expect(installs).toEqual(['npm ci --ignore-scripts', 'npm ci --ignore-scripts']);
	// The explicit check command performs the required SvelteKit sync after
	// installation; disabling npm's automatic prepare hook must not skip it.
	expect(workflow).toContain('- run: npm run check');
});

test('treats event names literally rather than as regular expressions', () => {
	expect(() => branchesFor('.*')).toThrow('.* must have an explicit branch list');
});
