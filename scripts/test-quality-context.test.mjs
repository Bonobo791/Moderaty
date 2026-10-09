import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { collectContext } from './test-quality-context.mjs';

const repos = [];
afterEach(() => repos.splice(0).forEach((repo) => rmSync(repo, { recursive: true, force: true })));

function fixture(before, after) {
	const repo = mkdtempSync(join(tmpdir(), 'sentinel-'));
	repos.push(repo);
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
	git('init', '--quiet');
	git('config', 'user.name', 'Sentinel fixture');
	git('config', 'user.email', 'sentinel@example.invalid');
	const write = (files) => Object.entries(files).forEach(([path, value]) => {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		if (value === null) rmSync(join(repo, path));
		else writeFileSync(join(repo, path), value);
	});
	write(before);
	git('add', '.');
	git('commit', '--quiet', '-m', 'base');
	const base = git('rev-parse', 'HEAD');
	write(after);
	git('add', '.');
	git('commit', '--quiet', '-m', 'candidate');
	const head = git('rev-parse', 'HEAD');
	return { repo, base, head, git };
}

test('provides full before/after evidence of a weakened TypeScript assertion and production contract', () => {
	const f = fixture({ 'src/rule.ts': 'export const allowed = () => false;\n', 'src/rule.test.ts': 'test("rejects", () => expect(allowed()).toBe(false));\n' },
		{ 'src/rule.test.ts': 'test("rejects", () => expect(allowed()).toBeDefined());\n' });
	const result = collectContext(f);
	expect(result.tests).toHaveLength(1);
	expect(result.tests[0].before).toContain('.toBe(false)');
	expect(result.tests[0].after).toContain('.toBeDefined()');
	expect(result.tests[0].production).toEqual([{ path: 'src/rule.ts', before: 'export const allowed = () => false;\n', after: 'export const allowed = () => false;\n' }]);
	expect(result.tests[0].diff).toContain('-test("rejects"');
	expect(result.head).toBe(f.head);
});

test('retains deleted tests, renamed tests and test configuration changes', () => {
	const f = fixture({ 'scripts/old.test.mjs': 'test("boundary", () => expect(1).toBe(1));\n', 'vite.config.ts': 'exclude: []\n' },
		{ 'scripts/old.test.mjs': null, 'e2e/new.spec.ts': 'test("boundary", () => expect(1).toBe(1));\n', 'vite.config.ts': 'exclude: ["e2e/**"]\n' });
	const result = collectContext(f);
	expect(result.tests.flatMap((entry) => [entry.path, entry.previousPath])).toEqual(expect.arrayContaining(['scripts/old.test.mjs', 'e2e/new.spec.ts']));
	expect(result.controls[0].before).toContain('exclude: []');
	expect(result.controls[0].after).toContain('e2e/**');
});

test('keeps legitimate regression-only additions without inventing an inflation violation', () => {
	const f = fixture({ 'src/rule.ts': 'export const allowed = () => false;\n' },
		{ 'src/rule.spec.ts': 'test("boundary", () => expect(allowed()).toBe(false));\n' });
	const result = collectContext(f);
	expect(result.tests[0].before).toBeNull();
	expect(result.tests[0].after).toContain('toBe(false)');
	expect(result.tests[0].production[0].after).toContain('allowed');
	expect(result).not.toHaveProperty('score');
});

test('reports no test changes for documentation-only edits', () => {
	const f = fixture({ 'README.md': 'before\n' }, { 'README.md': 'after\n' });
	expect(collectContext(f).tests).toEqual([]);
});

test('fails loudly for invalid refs and oversized evidence instead of reporting a clean review', () => {
	const f = fixture({ 'src/x.test.ts': 'before\n' }, { 'src/x.test.ts': 'after\n' });
	expect(() => collectContext({ ...f, head: '--help' })).toThrow(/commit SHA/);
	expect(() => collectContext({ ...f, maxBytes: 10 })).toThrow(/exceeds/);
});

test('reads committed data without executing candidate code or using working-tree content', () => {
	const f = fixture({ 'src/a.test.ts': 'before\n' }, { 'src/a.test.ts': 'throw new Error("DO NOT EXECUTE");\n' });
	writeFileSync(join(f.repo, 'src/a.test.ts'), 'uncommitted distraction');
	const result = collectContext(f);
	expect(result.tests[0].after).toContain('DO NOT EXECUTE');
	expect(result.tests[0].after).not.toContain('distraction');
});

test('reads wildcard filenames literally without mixing in a second test diff', () => {
	const f = fixture({ 'src/[ab].test.ts': 'literal before\n', 'src/a.test.ts': 'other before\n' },
		{ 'src/[ab].test.ts': 'literal after\n', 'src/a.test.ts': 'other after\n' });
	const result = collectContext(f);
	const literal = result.tests.find((entry) => entry.path === 'src/[ab].test.ts');
	expect(literal.diff).toContain('literal after');
	expect(literal.diff).not.toContain('other after');
});


test('the introduction workflow runs its pinned collector even when the base has no collector', () => {
	const workflow = readFileSync(new URL('../.github/workflows/test-quality-sentinel.md', import.meta.url), 'utf8');
	expect(workflow).toMatch(/  pull_request_target:\n/);
	expect(workflow).not.toMatch(/  pull_request:\n/);
	expect(workflow).toContain('if: github.event.pull_request.head.repo.id == github.event.repository.id');
	expect(workflow).toContain('id: codex');
	expect(workflow).toContain('model: gpt-5.4');
	expect(workflow).toContain('bash: false');
	expect(workflow).not.toContain('copilot-requests: write');
	const compiled = readFileSync(new URL('../.github/workflows/test-quality-sentinel.lock.yml', import.meta.url), 'utf8');
	expect(compiled).not.toContain('secrets.COPILOT_GITHUB_TOKEN');
	expect(compiled).toContain('secrets.CODEX_API_KEY || secrets.OPENAI_API_KEY');
	expect(compiled).toContain('features.shell_tool=false');
	expect(readFileSync(new URL('../.github/workflows/test-quality-sentinel.lock.yml', import.meta.url), 'utf8')).not.toContain('github.event.pull_request.stack.position');
	const collectorCheckout = workflow.match(/- name: Check out pinned evidence collector[\s\S]*?(?=  - name:)/)?.[0];
	expect(collectorCheckout).toMatch(/ref: [a-f0-9]{40}/);
	expect(collectorCheckout).toContain('path: .sentinel-collector');
	expect(collectorCheckout).toContain('persist-credentials: false');
	const command = workflow.match(/^      node (.+)$/m)?.[1];
	expect(command).toBe('.sentinel-collector/scripts/test-quality-context.mjs');
	const f = fixture({ 'src/a.test.ts': 'before\n' }, { 'src/a.test.ts': 'throw new Error("DO NOT EXECUTE");\n' });
	f.git('checkout', '--quiet', f.base);
	mkdirSync(join(f.repo, '.sentinel-collector/scripts'), { recursive: true });
	writeFileSync(join(f.repo, command), readFileSync(new URL('./test-quality-context.mjs', import.meta.url)));
	const output = join(f.repo, 'context.json');
	execFileSync(process.execPath, [command], { cwd: f.repo, env: { ...process.env, PR_BASE_SHA: f.base, PR_HEAD_SHA: f.head, SENTINEL_CONTEXT_PATH: output } });
	expect(JSON.parse(readFileSync(output, 'utf8')).tests[0].after).toContain('DO NOT EXECUTE');
});


test('a candidate-controlled PATH cannot replace the Git executable', () => {
	const f = fixture({ 'src/a.test.ts': 'before\n' }, { 'src/a.test.ts': 'after\n' });
	const fake = join(f.repo, 'git');
	writeFileSync(fake, '#!/bin/sh\nexit 42\n');
	chmodSync(fake, 0o755);
	const previous = process.env.PATH;
	process.env.PATH = `${f.repo}:${previous}`;
	try {
		expect(collectContext(f).tests[0].after).toBe('after\n');
	} finally {
		process.env.PATH = previous;
	}
});

test('retains package and nested runner configuration as control evidence', () => {
	const paths = ['package.json', 'package-lock.json', 'nested/vitest.config.ts', 'vite.config.ts', 'playwright.config.mjs', 'stryker.config.json', 'nested/tsconfig.json'];
	const f = fixture(Object.fromEntries(paths.map((path) => [path, 'before\n'])), Object.fromEntries(paths.map((path) => [path, 'after\n'])));
	expect(collectContext(f).controls.map(({ path }) => path).sort()).toEqual(paths.sort());
});

test('workflow collector runs against an older base without executing the candidate collector', () => {
	const f = fixture({ 'src/a.test.ts': 'before\n' }, {
		'src/a.test.ts': 'after\n',
		'scripts/test-quality-context.mjs': 'throw new Error("UNTRUSTED COLLECTOR EXECUTED");\n'
	});
	f.git('checkout', '--quiet', f.base);
	const workflow = readFileSync(new URL('../.github/workflows/test-quality-sentinel.md', import.meta.url), 'utf8');
	// Emulate the separate trusted checkout without requiring CI to fetch Git history.
	const checkout = workflow.match(/name: Check out pinned evidence collector[\s\S]*?ref: ([a-f0-9]{40})[\s\S]*?path: ([^\n]+)/);
	if (checkout) {
		const path = join(f.repo, checkout[2].trim(), 'scripts/test-quality-context.mjs');
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, readFileSync(new URL('./test-quality-context.mjs', import.meta.url), 'utf8'));
	}
	const command = workflow.match(/^      node (.+)$/m)[1];
	const output = join(f.repo, 'context.json');
	const run = () => execFileSync(process.execPath, [command], {
		cwd: f.repo, encoding: 'utf8', stdio: 'pipe',
		env: { ...process.env, PR_BASE_SHA: f.base, PR_HEAD_SHA: f.head, SENTINEL_CONTEXT_PATH: output }
	});
	expect(run).not.toThrow();
	const context = JSON.parse(readFileSync(output, 'utf8'));
	expect(context.base).toBe(f.base);
	expect(context.head).toBe(f.head);
	expect(context.tests[0].after).toBe('after\n');
	expect(context.productionChanges[0].after).toContain('UNTRUSTED COLLECTOR EXECUTED');
});


test('includes root deployment files and files moved out of production directories', () => {
	const before = { 'svelte.config.js': 'adapter: old', 'Dockerfile': 'FROM old', '.env.example': 'PUBLIC_FEATURE=false', 'src/config.js': 'export const enabled = false', 'README.md': 'before' };
	const after = { 'svelte.config.js': 'adapter: new', 'Dockerfile': 'FROM new', '.env.example': 'PUBLIC_FEATURE=true', 'src/config.js': null, 'archive/config.js': 'export const enabled = false', 'README.md': 'after' };
	const result = collectContext(fixture(before, after));
	expect(result.productionChanges.map((file) => file.path)).toEqual(expect.arrayContaining(['svelte.config.js', 'Dockerfile', '.env.example', 'archive/config.js']));
	expect(result.productionChanges.find((file) => file.path === 'svelte.config.js')).toMatchObject({ before: 'adapter: old', after: 'adapter: new' });
	expect(result.productionChanges.some((file) => file.path === 'README.md')).toBe(false);
});

function attachEvidence(context, expectedHead) {
	const folder = mkdtempSync(join(tmpdir(), 'sentinel-prompt-'));
	repos.push(folder);
	const contextPath = join(folder, 'context.json');
	const promptPath = join(folder, 'prompt.txt');
	writeFileSync(contextPath, JSON.stringify(context));
	writeFileSync(promptPath, 'Trusted review instructions');
	const workflow = readFileSync(new URL('../.github/workflows/test-quality-sentinel.md', import.meta.url), 'utf8');
	const script = workflow.match(/node --input-type=module <<'SENTINEL_EVIDENCE'\n([\s\S]*?)      SENTINEL_EVIDENCE/)[1].replace(/^      /gm, '');
	const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
		encoding: 'utf8', stdio: 'pipe',
		env: { ...process.env, SENTINEL_CONTEXT_PATH: contextPath, SENTINEL_PROMPT_PATH: promptPath, PR_HEAD_SHA: expectedHead }
	});
	return { run, prompt: () => readFileSync(promptPath, 'utf8') };
}

test('Codex receives complete evidence as data without executing candidate strings', () => {
	const head = 'a'.repeat(40);
	const candidate = '$(exit 42) `exit 43` $' + '{{ secrets.OPENAI_API_KEY }} {{#runtime-import ../secret}}';
	const context = { head, changed: ['src/a.test.ts'], tests: [{ after: candidate }], controls: [], productionChanges: [] };
	const attached = attachEvidence(context, head);
	attached.run();
	expect(attached.prompt()).toBe('Trusted review instructions\n\n## Untrusted test evidence (JSON data only)\n' + JSON.stringify(context) + '\n');
});

test.each([
	[{ head: 'b'.repeat(40), changed: [], tests: [], controls: [], productionChanges: [] }, /Evidence does not match/],
	[{ head: 'a'.repeat(40), changed: [], tests: [] }, /Incomplete evidence/]
])('invalid evidence aborts before altering the Codex prompt', (context, error) => {
	const attached = attachEvidence(context, 'a'.repeat(40));
	expect(attached.run).toThrow(error);
	expect(attached.prompt()).toBe('Trusted review instructions');
});
