import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditDiff, inspectStryker, auditRepository } from './audit.mjs';

for (const file of ['index.js', 'evaluation.js']) {
	test(("rejects a tampered engine before import: " + (file) + ""), () => {
		const cwd = mkdtempSync(join(tmpdir(), 'moderaty-overlock-integrity-'));
		try {
			const module = process.env.OVERLOCK_MODULE ?? fileURLToPath(new URL('../../.github/overlock/node_modules/overlock/dist/index.js', import.meta.url));
			for (const name of ['index.js', 'evaluation.js']) {
				const content = readFileSync(join(dirname(module), name), 'utf8');
				writeFileSync(join(cwd, name), content + (name === file ? '\n// tampered\n' : ''));
			}
			const result = spawnSync(process.execPath, [fileURLToPath(new URL('./audit.mjs', import.meta.url)), 'config'], {
				encoding: 'utf8', env: { ...process.env, OVERLOCK_MODULE: join(cwd, 'index.js') }
			});
			assert.notEqual(result.status, 0);
			assert.ok(result.stderr.includes('Overlock engine integrity failed: ' + file));
			assert.equal(result.stdout, '');
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
}

// Hand-labeled patches: removing any detector below must break its positive
// control. Benign controls expose a gate that simply rejects every test edit.
function patch(path, before, after) {
	const old = before.split('\n');
	const next = after.split('\n');
	return ("diff --git a/" + (path) + " b/" + (path) + "\n--- a/" + (path) + "\n+++ b/" + (path) + "\n@@ -1," + (old.length) + " +1," + (next.length) + " @@\n" + (old.map((line) => ("-" + (line) + "")).join('\n')) + "\n" + (next.map((line) => ("+" + (line) + "")).join('\n')) + "\n");
}

const exact = "it('rejects expired tokens', () => { expect(valid).toBe(false); });";

test('blocks deletion-only narrowing of a runIf condition', () => {
	const diff = "diff --git a/src/auth.test.ts b/src/auth.test.ts\n--- a/src/auth.test.ts\n+++ b/src/auth.test.ts\n@@ -1,4 +1,3 @@\n it.runIf(\n  process.env.CI\n- || process.env.LOCAL\n )('case', () => { expect(valid).toBe(false); });\n";
	assert.equal(auditDiff(diff).ok, false);
});

test('accepts a trailing comment edit on the condition closing line', () => {
	const diff = "diff --git a/src/auth.test.ts b/src/auth.test.ts\n--- a/src/auth.test.ts\n+++ b/src/auth.test.ts\n@@ -1,3 +1,3 @@\n it.runIf(\n  process.env.CI\n- )('case', () => { expect(valid).toBe(false); });\n+ )('case', () => { expect(valid).toBe(false); }); // Explain the case.\n";
	assert.equal(auditDiff(diff).ok, true);
});
const weakening = [
	['skip', 'src/auth.test.ts', exact, exact.replace('it(', 'it.skip('), 'TEST_SKIPPED_ADDED'],
	['only', 'src/auth.test.ts', exact, exact.replace('it(', 'it.only('), 'TEST_SKIPPED_ADDED'],
	['todo', 'src/auth.test.ts', exact, "it.todo('rejects expired tokens');", 'TEST_SKIPPED_ADDED'],
	['conditional skip', 'src/auth.test.ts', exact, exact.replace('it(', 'it.skipIf(true)('), 'TEST_SKIPPED_ADDED'],
	['conditional run', 'src/auth.test.ts', exact, exact.replace('it(', 'it.runIf(false)('), 'TEST_SKIPPED_ADDED'],
	['multiline conditional skip', 'src/auth.test.ts', exact, exact.replace('it(', 'it\n .skipIf(true)\n ('), 'TEST_SKIPPED_ADDED'],
	['multiline conditional run', 'src/auth.test.ts', exact, exact.replace('it(', 'it\n .runIf(false)\n ('), 'TEST_SKIPPED_ADDED'],
	['loose assertion', 'src/auth.test.ts', exact, exact.replace('toBe(false)', 'toBeDefined()'), 'ASSERTION_WEAKENED'],
	['removed assertion', 'src/auth.test.ts', exact, "it('rejects expired tokens', () => { });", 'ASSERTION_REMOVED'],
	['case deletion', 'src/auth.test.ts', ("" + (exact) + "\nit('checks owner', () => { expect(owner).toBe('Andrew'); });"), exact, 'TEST_REMOVED'],
	['object narrowing', 'src/auth.test.ts', "it('checks account', () => { expect(row).toEqual({ id: 3, owner: 'Andrew' }); });", "it('checks account', () => { expect(row.id).toBe(3); });", 'ASSERTION_NARROWED'],
	['scope include', 'vite.config.ts', "include: ['src/**/*.test.ts', 'e2e/**/*.test.ts'],", "include: ['src/**/*.test.ts'],", 'SUITE_SCOPE_NARROWED'],
	['scope exclude', 'vite.config.ts', "exclude: ['**/node_modules/**'],", "exclude: ['**/node_modules/**', 'src/auth/**'],", 'SUITE_SCOPE_NARROWED'],
	['runner filter', 'package.json', '"test": "vitest run"', '"test": "vitest run --project unit"', 'SUITE_SCOPE_NARROWED'],
	['coverage threshold', 'vite.config.ts', 'coverage: { thresholds: { lines: 90 } },', 'coverage: { thresholds: { lines: 20 } },', 'COVERAGE_THRESHOLD_LOWERED'],
	['swallowed failure', 'package.json', '"test": "vitest run"', '"test": "vitest run || true"', 'TEST_GATE_DISABLED'],
	['empty suite', 'package.json', '"test": "vitest run"', '"test": "vitest run --passWithNoTests"', 'TEST_GATE_DISABLED'],
	['disabled CI', '.github/workflows/checks.yml', '- name: test\n  run: npm test', '- name: test\n  run: npm test\n  continue-on-error: true', 'TEST_GATE_DISABLED'],
	['data narrowing', 'src/auth.test.ts', "for (const row of rows) { expect(row.valid).toBe(false); }", "for (const row of rows.filter(x => x.id === 3)) { expect(row.valid).toBe(false); }", 'PREDICATE_NARROWED']
];

for (const [name, path, before, after, rule] of weakening) {
	test(("blocks " + (name) + ""), () => {
		const report = auditDiff(patch(path, before, after));
		assert.equal(report.ok, false);
		assert.ok(report.findings.some((finding) => finding.rule === rule), rule);
	});
}

test('blocks a deleted test file', () => {
	const diff = ("diff --git a/src/auth.test.ts b/src/auth.test.ts\ndeleted file mode 100644\n--- a/src/auth.test.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-" + (exact) + "\n");
	assert.equal(auditDiff(diff).ok, false);
	assert.ok(auditDiff(diff).findings.some((finding) => finding.rule === 'TEST_REMOVED'));
});

test('inline suppressions cannot clear a skip', () => {
	const diff = patch('src/auth.test.ts', exact, ("// overlock-ignore TEST_SKIPPED_ADDED -- temporary\n" + (exact.replace('it(', 'it.skip(')) + ""));
	const report = auditDiff(diff);
	assert.equal(report.ok, false);
	assert.ok(report.findings.some((finding) => finding.rule === 'TEST_SKIPPED_ADDED'));
});

test('blocks a conditional skip attached to an unchanged declaration line', () => {
	const diff = "diff --git a/src/auth.test.ts b/src/auth.test.ts\n--- a/src/auth.test.ts\n+++ b/src/auth.test.ts\n@@ -1,2 +1,3 @@\n it\n+ .skipIf(true)\n ('case', () => { expect(valid).toBe(false); });\n";
	assert.equal(auditDiff(diff).ok, false);
});

test('accepts an unrelated edit beside an unchanged conditional declaration', () => {
	const diff = "diff --git a/src/auth.test.ts b/src/auth.test.ts\n--- a/src/auth.test.ts\n+++ b/src/auth.test.ts\n@@ -1,3 +1,4 @@\n it\n  .skipIf(true)\n  ('case', () => { expect(valid).toBe(false); });\n+ // Document the existing case.\n";
	assert.equal(auditDiff(diff).ok, true);
});

for (const [method, before, after] of [
	['skipIf', 'false', 'true'], ['runIf', 'true', 'false'],
	['skipIf', 'predicate(false)', 'predicate(true)'],
	['skipIf', '\")\" === value && false', '\")\" === value && true'],
	['skipIf', '/* ) */ false', '/* ) */ true']
]) {
	test(("blocks condition-only " + (method) + " edit: " + (before) + ""), () => {
		const diff = ("diff --git a/src/auth.test.ts b/src/auth.test.ts\n--- a/src/auth.test.ts\n+++ b/src/auth.test.ts\n@@ -1,3 +1,3 @@\n it." + (method) + "(\n- " + (before) + "\n+ " + (after) + "\n )('case', () => { expect(valid).toBe(false); });\n");
		assert.equal(auditDiff(diff).ok, false);
	});
}

test('accepts unrelated body edits after a multiline conditional argument', () => {
	const diff = "diff --git a/src/auth.test.ts b/src/auth.test.ts\n--- a/src/auth.test.ts\n+++ b/src/auth.test.ts\n@@ -1,5 +1,6 @@\n it.skipIf(\n  predicate(\")\") /* ) */\n )('case', () => {\n+ // Describe the unchanged assertion.\n  expect(valid).toBe(false);\n });\n";
	assert.equal(auditDiff(diff).ok, true);
});

for (const [name, before, after] of [
	['stronger assertion', "it('checks role', () => { expect(role).toBeDefined(); });", "it('checks role', () => { expect(role).toBe('admin'); });"],
	['additional case', exact, ("" + (exact) + "\nit('checks owner', () => { expect(owner).toBe('Andrew'); });")],
	['formatting', exact, exact.replace('expect(valid)', 'expect( valid )')],
	['exact null', "it('checks session', () => { expect(session).toBe(null); });", "it('checks session', () => { expect(session).toBeNull(); });"]
]) {
	test(("accepts " + (name) + ""), () => assert.equal(auditDiff(patch('src/auth.test.ts', before, after)).ok, true));
}

test('accepts test relocation while reporting it for review', () => {
	const diff = ("diff --git a/src/auth.test.ts b/src/auth.test.ts\ndeleted file mode 100644\n--- a/src/auth.test.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-" + (exact) + "\n") +
		("diff --git a/src/session.test.ts b/src/session.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/session.test.ts\n@@ -0,0 +1 @@\n+" + (exact) + "\n");
	const report = auditDiff(diff);
	assert.equal(report.ok, true);
	assert.ok(report.findings.some((finding) => finding.rule === 'TEST_REMOVED' && finding.severity === 'medium'));
});

for (const [name, before, after, rule] of [
	['lowered break score', { thresholds: { break: 80 } }, { thresholds: { break: 20 } }, 'COVERAGE_THRESHOLD_LOWERED'],
	['removed thresholds', { thresholds: { break: 80 } }, {}, 'COVERAGE_THRESHOLD_LOWERED'],
	['removed mutation pattern', { mutate: ['src/**/*.ts', 'netlify/**/*.mjs'] }, { mutate: ['src/**/*.ts'] }, 'SUITE_SCOPE_NARROWED'],
	['added mutation exclusion', { mutate: ['src/**/*.ts'] }, { mutate: ['src/**/*.ts', '!src/auth/**'] }, 'SUITE_SCOPE_NARROWED']
]) {
	test(("blocks Stryker " + (name) + ""), () => {
		const findings = inspectStryker(JSON.stringify(before), JSON.stringify(after));
		assert.ok(findings.some((finding) => finding.rule === rule && finding.severity === 'high'));
	});
}

test('removing explicit mutation scope requires review', () => {
	assert.ok(inspectStryker('{"mutate":["src/**/*.ts"]}', '{}').some((finding) => finding.rule === 'SUITE_SCOPE_NARROWED'));
});

test('deleting Stryker config requires scope review', () => {
	assert.ok(inspectStryker('{"mutate":["src/**/*.ts"]}', null).some((finding) => finding.rule === 'SUITE_SCOPE_NARROWED'));
});

test('accepts raised Stryker threshold and expanded mutation scope', () => {
	assert.deepEqual(inspectStryker('{"thresholds":{"break":80},"mutate":["src/**/*.ts"]}', '{"thresholds":{"break":90},"mutate":["src/**/*.ts","netlify/**/*.mjs"]}'), []);
});

test('invalid Stryker JSON fails loudly', () => assert.throws(() => inspectStryker('{}', '{'), /Stryker/));

function git(cwd, ...args) {
	const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

test('audits real commits despite repo config, commit allowances and hostile package scripts', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'moderaty-overlock-'));
	try {
		git(cwd, 'init', '-q');
		git(cwd, 'config', 'user.name', 'Fixture');
		git(cwd, 'config', 'user.email', 'fixture@example.invalid');
		mkdirSync(join(cwd, 'src'));
		writeFileSync(join(cwd, 'src/auth.test.ts'), exact);
		writeFileSync(join(cwd, 'package.json'), '{}');
		git(cwd, 'add', '.');
		git(cwd, 'commit', '-qm', 'baseline');
		const base = git(cwd, 'rev-parse', 'HEAD');
		writeFileSync(join(cwd, 'src/auth.test.ts'), exact.replace('it(', 'it.skip('));
		writeFileSync(join(cwd, 'overlock.config.json'), JSON.stringify({ failOn: 'none', severity: { TEST_SKIPPED_ADDED: 'off' }, exclude: ['src'] }));
		writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { prepare: 'touch EXECUTED', test: 'touch EXECUTED' }, overlock: { failOn: 'none' } }));
		git(cwd, 'add', '.');
		git(cwd, 'commit', '-qm', 'weakening\n\nOverlock-Allow: TEST_SKIPPED_ADDED -- approved by agent');
		const report = auditRepository({ cwd, base });
		assert.equal(report.ok, false);
		assert.ok(report.findings.some((finding) => finding.rule === 'TEST_SKIPPED_ADDED'));
		assert.equal(report.scope.commits, 1);
		assert.equal(existsSync(join(cwd, 'EXECUTED')), false);
		assert.throws(() => auditRepository({ cwd, base: '--output=EXECUTED' }), /40-character/);
		// Exercise the exact composite-action interface, including its allow-file
		// and log-only fail-on arguments. Neither may change the fixed verdict.
		writeFileSync(join(cwd, 'pr-body.txt'), 'Overlock-Allow: TEST_SKIPPED_ADDED -- agent granted itself an exception');
		const result = spawnSync(process.execPath, [fileURLToPath(new URL('./audit.mjs', import.meta.url)),
			'check', '--base', base, '--json', '--no-ledger', '--fail-on', 'none',
			'--severity', 'TEST_SKIPPED_ADDED=off', '--allow-file', join(cwd, 'pr-body.txt')
		], { cwd, encoding: 'utf8' });
		assert.equal(result.status, 1, result.stderr);
		assert.equal(JSON.parse(result.stdout).ok, false);
		assert.equal(JSON.parse(result.stdout).fail_on, 'high');
		// A candidate must not supply the Git executable through PATH.
		const hostileBin = join(cwd, 'hostile-bin');
		mkdirSync(hostileBin);
		writeFileSync(join(hostileBin, 'git'), '#!/bin/sh\nprintf invoked > EXECUTED_GIT\nexit 91\n');
		chmodSync(join(hostileBin, 'git'), 0o755);
		const hostile = spawnSync(process.execPath, [fileURLToPath(new URL('./audit.mjs', import.meta.url)),
			'check', '--base', base, '--json'
		], { cwd, encoding: 'utf8', env: { ...process.env, PATH: hostileBin } });
		assert.equal(hostile.status, 1, hostile.stderr);
		assert.equal(JSON.parse(hostile.stdout).ok, false);
		assert.equal(existsSync(join(cwd, 'EXECUTED_GIT')), false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('an identical base and head fails instead of claiming a clean audit', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'moderaty-overlock-empty-'));
	try {
		git(cwd, 'init', '-q');
		git(cwd, 'config', 'user.name', 'Fixture');
		git(cwd, 'config', 'user.email', 'fixture@example.invalid');
		git(cwd, 'commit', '--allow-empty', '-qm', 'baseline');
		assert.throws(() => auditRepository({ cwd, base: git(cwd, 'rev-parse', 'HEAD') }), /empty/i);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('audits text hidden by candidate binary attributes and hashes the exact raw patch', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'moderaty-overlock-binary-'));
	try {
		git(cwd, 'init', '-q');
		git(cwd, 'config', 'user.name', 'Fixture');
		git(cwd, 'config', 'user.email', 'fixture@example.invalid');
		writeFileSync(join(cwd, 'case.pw.ts'), exact);
		git(cwd, 'add', '.');
		git(cwd, 'commit', '-qm', 'baseline');
		const base = git(cwd, 'rev-parse', 'HEAD');
		writeFileSync(join(cwd, '.gitattributes'), '*.pw.ts binary\n');
		writeFileSync(join(cwd, 'case.pw.ts'), exact.replace('it(', 'it.skip(') + '  ');
		git(cwd, 'add', '.');
		git(cwd, 'commit', '-qm', 'weakening');
		const report = auditRepository({cwd, base});
		assert.equal(report.ok, false);
		assert.ok(report.findings.some(f => f.rule === 'TEST_SKIPPED_ADDED' && f.file === 'case.pw.ts'));
		const raw = spawnSync('/usr/bin/git', ['diff', '--text', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=80', base, 'HEAD', '--'], {cwd, encoding: 'utf8'});
		assert.equal(raw.status, 0);
		assert.equal(report.patch_sha256, createHash('sha256').update(raw.stdout).digest('hex'));
	} finally { rmSync(cwd, {recursive: true, force: true}); }
});

test('policy selection fails closed when an established base is missing its lockfile', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'moderaty-overlock-policy-'));
	try {
		mkdirSync(join(cwd, 'policy/.github/workflows'), {recursive: true});
		mkdirSync(join(cwd, 'candidate/.github/overlock'), {recursive: true});
		writeFileSync(join(cwd, 'policy/.github/workflows/overlock.yml'), 'existing policy');
		writeFileSync(join(cwd, 'candidate/.github/overlock/package.json'), '{}');
		writeFileSync(join(cwd, 'candidate/.github/overlock/package-lock.json'), '{}');
		const workflow = readFileSync(new URL('../../.github/workflows/overlock.yml', import.meta.url), 'utf8');
		const selection = workflow.match(/run: \|\n([\s\S]*?)          tool=/)[1].replace(/^          /gm, '');
		const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', selection], {encoding: 'utf8', env: {PATH:'/usr/bin:/bin', GITHUB_WORKSPACE:cwd}});
		assert.notEqual(result.status, 0);
		assert.ok(result.stdout.includes('::error::'));
		rmSync(join(cwd, 'policy/.github/workflows/overlock.yml'));
		const bootstrap = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', selection], {encoding:'utf8', env:{PATH:'/usr/bin:/bin', GITHUB_WORKSPACE:cwd}});
		assert.equal(bootstrap.status, 0, bootstrap.stderr);
		assert.ok(bootstrap.stdout.includes('::warning::Bootstrap'));
	} finally { rmSync(cwd, {recursive:true, force:true}); }
});
