import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './json.mjs';

const pin = 'd72ca6de67c38bab028015991203c7eeff4dce90';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.argv.length, 2, 'fixture harness does not accept CLI paths');
const tool = resolve(repo, '../gate-tool');
const output = mkdtempSync(resolve(tmpdir(), 'moderaty-merge-examples-'));
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim();
assert.equal(git(tool, 'rev-parse', 'HEAD'), pin, 'use the reviewed upstream revision');
assert.equal(git(tool, 'hash-object', 'dist/index.js'), git(tool, 'rev-parse', 'HEAD:dist/index.js'), 'action bundle was modified');
mkdirSync(output, { recursive: true });
const source = 'export const add = (a, b) => a + b;\n';
const tests = "import { expect, test } from 'vitest';\nimport { add } from './sum.js';\ntest('adds', () => expect(add(2, 3)).toBe(5));\n";
const extra = "import { expect, test } from 'vitest';\nimport { add } from './sum.js';\ntest('adds zero', () => expect(add(0, 3)).toBe(3));\n";
const scenarios = [
	{ name: 'human-passing', body: '`npm test` passed. 2 tests, 0 failures.', accept: true },
	{ name: 'failing-assertion', body: '`npm test` passed. 2 tests, 0 failures.', source: 'export const add = () => 999;\n', accept: false, check: 'C1', baseline: true, introduced: 2 },
	{ name: 'failure-without-claims', body: 'Change addition behavior.', source: 'export const add = () => 999;\n', accept: false },
	{ name: 'inflated-count', body: '`npm test` passed. 999 tests, 0 failures.', accept: false, check: 'C2' },
	{ name: 'tests-added-without-tests', body: '`npm test` passed.\n- [x] I have added tests', source: `${source}// Candidate change with no test edit.\n`, accept: false, check: 'C7' },
	{ name: 'skipped-test', body: '`npm test` passed.', tests: tests.replace("test('adds'", "test.skip('adds'"), accept: false, check: 'C3', review: true },
	{ name: 'runtime-skipped-test', body: '`npm test` passed. sum.test.js changed.', tests: tests.replace("() => expect(add(2, 3)).toBe(5)", "({ skip }) => { skip(); expect(add(2, 3)).toBe(5); }"), accept: false, runtimeSkip: true },
	{ name: 'deleted-test', body: '`npm test` passed.', remove: true, accept: false, check: 'C3', review: true },
	{ name: 'weakened-ci', body: '`npm test` passed.', ci: 'name: checks\non: pull_request\njobs:\n  test:\n    continue-on-error: true\n', accept: false, check: 'C4', review: true },
	{ name: 'focused-test', body: '`npm test` passed.', tests: tests.replace("test('adds'", "test.only('adds'"), accept: false, check: 'C3', review: true, verdict: 'FAIL' },
	{ name: 'renamed-away-test', body: '`npm test` passed. zero.js renamed from zero.test.js.', rename: true, accept: false, check: 'C3', review: true },
	{ name: 'unmentioned-dependency', body: '`npm test` passed.', dependency: true, accept: false, check: 'C5', review: true },
	{ name: 'mentioned-dependency', body: '`npm test` passed. package.json description updated.', dependency: true, accept: true },
	{ name: 'updated-snapshot', body: '`npm test` passed.', snapshot: true, accept: false, check: 'C6', review: true },
	{ name: 'unmentioned-scope', body: '`npm test` passed.', scope: true, accept: false, check: 'C8', review: true },
	{ name: 'mentioned-scope', body: '`npm test` passed. extra.js added.', scope: true, accept: true },
	{ name: 'lowered-coverage', body: '`npm test` passed. vitest.config.mjs threshold changed.', coverage: true, accept: false, check: 'C4', review: true },
	{ name: 'gate-policy-edit', body: '`npm test` passed. .github/merge-evidence-policy.yml changed.', gatePolicy: true, accept: false, localReview: true },
	{ name: 'gate-verifier-edit', body: '`npm test` passed. scripts/merge-evidence/verify.mjs changed.', gateVerifier: true, accept: false, localReview: true },
	{ name: 'unavailable-diff', body: '`npm test` passed.', missingBase: true, accept: false },
	{ name: 'pre-existing-failure', body: '`npm test` failed. sum.js already broken.', baseSource: 'export const add = () => 999;\n', accept: false, baseline: true, introduced: 0, preExisting: 2 },
	{ name: 'removed-test-with-failure', body: 'sum.js changed; zero.test.js removed.', source: 'export const add = () => 999;\n', remove: true, accept: false, baseline: true, introduced: 1, check: 'C3' },
	{ name: 'legitimate-test-addition', body: '`npm test` passed. 3 tests, 0 failures.\n- [x] I have added tests', add: true, accept: true },
	{ name: 'stale-report-no-execution', body: '`npm test` passed. 2 tests, 0 failures.', noop: true, stale: true, accept: false }
];
const results = [];
for (const scenario of scenarios) {
	const dir = resolve(output, scenario.name); mkdirSync(dir);
	const write = (path, text) => { mkdirSync(dirname(resolve(dir, path)), { recursive: true }); writeFileSync(resolve(dir, path), text); };
	git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 'fixture@example.invalid'); git(dir, 'config', 'user.name', 'Fixture');
	write('.gitignore', 'node_modules/\n.merge-evidence/\nreceipt.json\n');
	write('package.json', JSON.stringify({ type: 'module', scripts: { test: 'vitest run' }, devDependencies: { vitest: '5.0.1' } }));
	write('tsconfig.json', '{}'); write('vitest.config.mjs', 'export default { test: { environment: "node", coverage: { thresholds: { lines: 90 } } } };\n');
	write('sum.js', scenario.baseSource ?? source); write('sum.test.js', tests); write('zero.test.js', extra);
	write('.github/workflows/checks.yml', 'name: checks\non: pull_request\n');
	write('.github/merge-evidence-policy.yml', readFileSync(resolve(repo, '.github/merge-evidence-policy.yml'), 'utf8'));
	git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base'); const baseSha = scenario.missingBase ? 'f'.repeat(40) : git(dir, 'rev-parse', 'HEAD');
	if (scenario.source) write('sum.js', scenario.source);
	if (scenario.tests) write('sum.test.js', scenario.tests);
	if (scenario.remove) git(dir, 'rm', 'zero.test.js');
	if (scenario.rename) git(dir, 'mv', 'zero.test.js', 'zero.js');
	if (scenario.dependency) write('package.json', JSON.stringify({ type: 'module', description: 'dependency manifest edited', scripts: { test: 'vitest run' }, devDependencies: { vitest: '5.0.1' } }));
	if (scenario.snapshot) write('testdata/sum.golden', 'updated golden output\n');
	if (scenario.scope) write('extra.js', 'export const extra = 1;\n');
	if (scenario.coverage) write('vitest.config.mjs', 'export default { test: { environment: "node", coverage: { thresholds: { lines: 0 } } } };\n');
	if (scenario.gatePolicy) write('.github/merge-evidence-policy.yml', readFileSync(resolve(repo, '.github/merge-evidence-policy.yml'), 'utf8') + '# policy edit\n');
	if (scenario.gateVerifier) write('scripts/merge-evidence/verify.mjs', 'console.log("unchecked");\n');
	if (scenario.add) write('extra.test.js', extra.replace('adds zero', 'adds zero again'));
	if (scenario.ci) write('.github/workflows/checks.yml', scenario.ci);
	if (scenario.noop) write('package.json', JSON.stringify({ type: 'module', scripts: { test: 'true' }, devDependencies: { vitest: '5.0.1' } }));
	git(dir, 'add', '.'); git(dir, 'commit', '--allow-empty', '-qm', 'candidate'); const headSha = git(dir, 'rev-parse', 'HEAD');
	symlinkSync(resolve(repo, 'node_modules'), resolve(dir, 'node_modules'), 'dir');
	write('event.json', JSON.stringify({ repository: { full_name: 'fixture/moderaty', owner: { login: 'fixture' }, name: 'moderaty' },
		pull_request: { number: 1, head: { sha: headSha, ref: 'ordinary-human-work' }, base: { sha: baseSha, ref: 'main' }, user: { login: 'human' }, title: scenario.name, body: scenario.body + (scenario.source ? '\nChanges sum.js.' : '') + (scenario.ci ? '\nChanges .github/workflows/checks.yml.' : '') } }));
	if (scenario.stale) write('.merge-evidence/vitest-results.json', JSON.stringify({ testResults: [{ assertionResults: [{ fullName: 'forged old pass', status: 'passed' }] }] }));
	const env = { ...process.env, GITHUB_WORKSPACE: dir, GITHUB_EVENT_PATH: resolve(dir, 'event.json'), GITHUB_EVENT_NAME: 'pull_request',
		GITHUB_REPOSITORY: 'fixture/moderaty', GITHUB_SHA: headSha, GITHUB_REF: 'refs/pull/1/head', GITHUB_STEP_SUMMARY: resolve(dir, 'summary.md'),
		GITHUB_OUTPUT: resolve(dir, 'outputs.txt'), 'INPUT_GITHUB-TOKEN': '', 'INPUT_AGENTS-ONLY': 'false', INPUT_EVIDENCE: 'run',
		'INPUT_TEST-COMMAND': 'npm test', 'INPUT_POLICY-FILE': '.github/merge-evidence-policy.yml', 'INPUT_BASE-COMPARISON': 'auto',
		'INPUT_FAIL-ON': 'needs-human', INPUT_COMMENT: 'false', 'INPUT_UPLOAD-RECEIPT': 'false', INPUT_SIGN: 'none' };
	const prepared = spawnSync(process.execPath, [resolve(repo, 'scripts/merge-evidence/prepare.mjs')], { cwd: dir, env, encoding: 'utf8' });
	if (scenario.noop) {
		assert.notEqual(prepared.status, 0, 'a no-op command must be rejected before reading its stale report');
		const result = { scenario: scenario.name, verdict: 'BLOCKED_BEFORE_RUN', accepted: false, reviewRequired: false };
		results.push(result); console.info(JSON.stringify(result)); continue;
	}
	assert.equal(prepared.status, 0, prepared.stderr);
	// GitHub creates these command files before an action starts. Emulate that
	// contract so a receipt written before a plumbing crash cannot pass a case.
	write('outputs.txt', ''); write('summary.md', '');
	const run = spawnSync(process.execPath, [resolve(tool, 'dist/index.js')], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
	write('action.log', `${run.stdout}\n${run.stderr}`);
	const receipt = readJson(resolve(dir, 'receipt.json'), `${scenario.name} receipt`);
	assert.equal(run.status, ['FAIL', 'NEEDS_HUMAN'].includes(receipt.verdict) ? 1 : 0, `${scenario.name}: action failed before applying its verdict`);
	const outputs = readFileSync(resolve(dir, 'outputs.txt'), 'utf8');
	assert.match(outputs, /verdict/);
	const digest = outputs.match(/receipt-sha256(?:=([a-f0-9]{64})|<<[^\n]+\n([a-f0-9]{64}))/);
	assert(digest, `${scenario.name}: no receipt digest output`);
	const receiptSha256 = digest[1] ?? digest[2];
	assert(readFileSync(resolve(dir, 'summary.md'), 'utf8').length > 0, 'action did not publish its summary');
	const verified = spawnSync(process.execPath, [resolve(repo, 'scripts/merge-evidence/verify.mjs'),
		'receipt.json', '.merge-evidence/vitest-results.json', 'merge-evidence-start.txt'], { cwd: dir,
		env: { ...env, MEG_HEAD_SHA: headSha, MEG_BASE_SHA: baseSha, MEG_RECEIPT_SHA256: receiptSha256 }, encoding: 'utf8' });
	write('verifier.log', `${verified.stdout}\n${verified.stderr}`);
	const accepted = verified.status === 0;
	assert.equal(accepted, scenario.accept, `${scenario.name}: unexpected acceptance; see ${dir}/action.log`);
	if (scenario.runtimeSkip) { assert.equal(receipt.observed.totals.skipped, 1); assert.match(verified.stderr, /owner review.*skipped/); }
	if (scenario.localReview) assert.match(verified.stderr, /owner review required for gate changes/);
	if (scenario.missingBase) assert.match(verified.stderr, /diff could not be independently verified/);
	if (scenario.check) assert(receipt.discrepancies.some((d) => d.check === scenario.check), `${scenario.name}: expected ${scenario.check}`);
	if (scenario.review) assert.equal(receipt.verdict, scenario.verdict ?? 'NEEDS_HUMAN');
	if (scenario.baseline) {
		assert.equal(receipt.observed.baseline?.sha, baseSha, `${scenario.name}: missing base execution`);
		assert.equal(receipt.observed.baseline.introduced.length, scenario.introduced);
		if (scenario.preExisting !== undefined) assert.equal(receipt.observed.baseline.pre_existing, scenario.preExisting);
		if (scenario.introduced > 0) assert(receipt.discrepancies.some((d) => d.check === 'C9'));
	}
	const result = { scenario: scenario.name, verdict: receipt.verdict, accepted, reviewRequired: scenario.review ?? scenario.localReview ?? scenario.runtimeSkip ?? false,
		verifierExit: verified.status, rejectionReason: accepted ? undefined : verified.stderr.trim(),
		actionExit: run.status, exitCode: receipt.observed.exit_code, tests: receipt.observed.totals, baseline: receipt.observed.baseline, checks: receipt.discrepancies.map((d) => d.check) };
	results.push(result); console.info(JSON.stringify(result));
}
writeFileSync(resolve(output, 'results.json'), JSON.stringify({ upstreamRevision: pin, scenarios: results }, null, 2));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `results-path=${resolve(output, 'results.json')}\n`);
console.info(`Examples verified; evidence: ${output}`);
