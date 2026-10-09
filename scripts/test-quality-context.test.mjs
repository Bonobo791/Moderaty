import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
