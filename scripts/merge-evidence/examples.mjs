import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFiles } from './verify.mjs';

const pin = 'd72ca6de67c38bab028015991203c7eeff4dce90';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tool = resolve(process.argv[2] ?? '');
const output = resolve(process.argv[3] ?? mkdtempSync(resolve(tmpdir(), 'moderaty-merge-examples-')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
assert.equal(git(tool, 'rev-parse', 'HEAD'), pin, 'use the reviewed upstream revision');
assert.equal(git(tool, 'hash-object', 'dist/index.js'), git(tool, 'rev-parse', 'HEAD:dist/index.js'), 'action bundle was modified');
mkdirSync(output, { recursive: true });
const source = 'export const add = (a, b) => a + b;\n';
const tests = "import { expect, test } from 'vitest';\nimport { add } from './sum.js';\ntest('adds', () => expect(add(2, 3)).toBe(5));\n";
const extra = "import { expect, test } from 'vitest';\nimport { add } from './sum.js';\ntest('adds zero', () => expect(add(0, 3)).toBe(3));\n";
const scenarios = [
	{ name: 'human-passing', body: '`npm test` passed. 2 tests, 0 failures.', accept: true },
	{ name: 'failing-assertion', body: '`npm test` passed. 2 tests, 0 failures.', source: 'export const add = () => 999;\n', accept: false, check: 'C1' },
	{ name: 'failure-without-claims', body: 'Change addition behavior.', source: 'export const add = () => 999;\n', accept: false },
	{ name: 'inflated-count', body: '`npm test` passed. 999 tests, 0 failures.', accept: false, check: 'C2' },
	{ name: 'tests-added-without-tests', body: '`npm test` passed.\n- [x] I have added tests', source: `${source}// Candidate change with no test edit.\n`, accept: false, check: 'C7' },
	{ name: 'skipped-test', body: '`npm test` passed.', tests: tests.replace("test('adds'", "test.skip('adds'"), accept: true, check: 'C3', review: true },
	{ name: 'deleted-test', body: '`npm test` passed.', remove: true, accept: true, check: 'C3', review: true },
	{ name: 'weakened-ci', body: '`npm test` passed.', ci: 'name: checks\non: pull_request\njobs:\n  test:\n    continue-on-error: true\n', accept: true, check: 'C4', review: true },
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
	write('tsconfig.json', '{}'); write('vitest.config.mjs', 'export default { test: { environment: "node" } };\n');
	write('sum.js', source); write('sum.test.js', tests); write('zero.test.js', extra);
	write('.github/workflows/checks.yml', 'name: checks\non: pull_request\n');
	write('.github/merge-evidence-policy.yml', readFileSync(resolve(repo, '.github/merge-evidence-policy.yml'), 'utf8'));
	git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base'); const baseSha = git(dir, 'rev-parse', 'HEAD');
	if (scenario.source) write('sum.js', scenario.source);
	if (scenario.tests) write('sum.test.js', scenario.tests);
	if (scenario.remove) git(dir, 'rm', 'zero.test.js');
	if (scenario.add) write('extra.test.js', extra.replace('adds zero', 'adds zero again'));
	if (scenario.ci) write('.github/workflows/checks.yml', scenario.ci);
	if (scenario.noop) write('package.json', JSON.stringify({ type: 'module', scripts: { test: 'true' }, devDependencies: { vitest: '5.0.1' } }));
	git(dir, 'add', '.'); git(dir, 'commit', '--allow-empty', '-qm', 'candidate'); const headSha = git(dir, 'rev-parse', 'HEAD');
	symlinkSync(resolve(repo, 'node_modules'), resolve(dir, 'node_modules'), 'dir');
	write('event.json', JSON.stringify({ repository: { full_name: 'fixture/moderaty', owner: { login: 'fixture' }, name: 'moderaty' },
		pull_request: { number: 1, head: { sha: headSha, ref: 'ordinary-human-work' }, base: { sha: baseSha, ref: 'main' }, user: { login: 'human' }, title: scenario.name, body: scenario.body } }));
	if (scenario.stale) write('.merge-evidence/vitest-results.json', JSON.stringify({ testResults: [{ assertionResults: [{ fullName: 'forged old pass', status: 'passed' }] }] }));
	const env = { ...process.env, GITHUB_WORKSPACE: dir, GITHUB_EVENT_PATH: resolve(dir, 'event.json'), GITHUB_EVENT_NAME: 'pull_request',
		GITHUB_REPOSITORY: 'fixture/moderaty', GITHUB_SHA: headSha, GITHUB_REF: 'refs/pull/1/head', GITHUB_STEP_SUMMARY: resolve(dir, 'summary.md'),
		GITHUB_OUTPUT: resolve(dir, 'outputs.txt'), 'INPUT_GITHUB-TOKEN': '', 'INPUT_AGENTS-ONLY': 'false', INPUT_EVIDENCE: 'run',
		'INPUT_TEST-COMMAND': 'npm test', 'INPUT_POLICY-FILE': '.github/merge-evidence-policy.yml', 'INPUT_BASE-COMPARISON': 'never',
		'INPUT_FAIL-ON': 'fail', INPUT_COMMENT: 'false', 'INPUT_UPLOAD-RECEIPT': 'false', INPUT_SIGN: 'none' };
	const prepared = spawnSync(process.execPath, [resolve(repo, 'scripts/merge-evidence/prepare.mjs')], { cwd: dir, env, encoding: 'utf8' });
	if (scenario.noop) {
		assert.notEqual(prepared.status, 0, 'a no-op command must be rejected before reading its stale report');
		const result = { scenario: scenario.name, verdict: 'BLOCKED_BEFORE_RUN', accepted: false, reviewRequired: false };
		results.push(result); console.info(JSON.stringify(result)); continue;
	}
	assert.equal(prepared.status, 0, prepared.stderr);
	const startedAt = readFileSync(resolve(dir, 'merge-evidence-start.txt'), 'utf8');
	// GitHub creates these command files before an action starts. Emulate that
	// contract so a receipt written before a plumbing crash cannot pass a case.
	write('outputs.txt', ''); write('summary.md', '');
	const run = spawnSync(process.execPath, [resolve(tool, 'dist/index.js')], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
	write('action.log', `${run.stdout}\n${run.stderr}`);
	const receipt = JSON.parse(readFileSync(resolve(dir, 'receipt.json'), 'utf8'));
	assert.equal(run.status, receipt.verdict === 'FAIL' ? 1 : 0, `${scenario.name}: action failed before applying its verdict`);
	assert.match(readFileSync(resolve(dir, 'outputs.txt'), 'utf8'), /verdict/);
	assert(readFileSync(resolve(dir, 'summary.md'), 'utf8').length > 0, 'action did not publish its summary');
	let accepted = true;
	try { verifyFiles(resolve(dir, 'receipt.json'), resolve(dir, '.merge-evidence/vitest-results.json'), { headSha, baseSha, startedAt }); }
	catch { accepted = false; }
	assert.equal(accepted, scenario.accept, `${scenario.name}: unexpected acceptance; see ${dir}/action.log`);
	if (scenario.check) assert(receipt.discrepancies.some((d) => d.check === scenario.check), `${scenario.name}: expected ${scenario.check}`);
	if (scenario.review) assert.equal(receipt.verdict, 'NEEDS_HUMAN');
	const result = { scenario: scenario.name, verdict: receipt.verdict, accepted, reviewRequired: scenario.review ?? false,
		actionExit: run.status, exitCode: receipt.observed.exit_code, tests: receipt.observed.totals, checks: receipt.discrepancies.map((d) => d.check) };
	results.push(result); console.info(JSON.stringify(result));
}
writeFileSync(resolve(output, 'results.json'), JSON.stringify({ upstreamRevision: pin, scenarios: results }, null, 2));
console.info(`Examples verified; evidence: ${output}`);
