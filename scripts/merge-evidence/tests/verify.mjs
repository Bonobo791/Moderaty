import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyFiles, verifyReceipt } from '../verify.mjs';
import { verifyCheckout } from '../checkout.mjs';

const context = { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), startedAt: '2026-10-09T12:00:00Z' };
function writeFreshReport(path, value) {
	writeFileSync(path, value);
	const timestamp = new Date('2026-10-09T12:00:01Z');
	utimesSync(path, timestamp, timestamp);
}
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const receipt = () => ({
	schema: 'merge-evidence/receipt/v1', generatedAt: '2026-10-09T12:00:01Z',
	pr: { head_sha: context.headSha, base_sha: context.baseSha },
	observed: { command: 'npm test -- --reporter=json --outputFile=.merge-evidence/vitest-results.json',
		exit_code: 0, totals: { run: 2, passed: 2, failed: 0, skipped: 0 } },
	diff: { tests: { added: [], deleted: [], skipped_added: [], focused: [] }, sensitive_paths: [], lockfiles: [], snapshots: [] }, verdict: 'PASS', discrepancies: []
});

test('accepts evidence from a fresh successful execution at the requested revision', () => {
	assert.doesNotThrow(() => verifyReceipt(receipt(), context));
});

for (const [name, change] of [
	['report ingestion', (r) => { r.observed.source = 'report'; }],
	['no evidence', (r) => { r.observed.no_evidence = true; }],
	['zero tests', (r) => { r.observed.totals = { run: 0, passed: 0, failed: 0, skipped: 0 }; }],
	['only skipped tests', (r) => { r.observed.totals = { run: 2, passed: 0, failed: 0, skipped: 2 }; }],
	['a genuine process failure', (r) => { r.observed.exit_code = 1; }],
	['a failed assertion', (r) => { r.observed.totals.failed = 1; }],
	['an old report', (r) => { r.generatedAt = '2026-10-08T12:00:00Z'; }],
	['another head', (r) => { r.pr.head_sha = 'c'.repeat(40); }],
	['another base', (r) => { r.pr.base_sha = 'c'.repeat(40); }],
	['an unreliable diff', (r) => { r.diff.unreliable = true; }],
	['an incomplete diff', (r) => { r.diff = {}; }],
	['a neutral abstention', (r) => { r.verdict = 'NEUTRAL'; }],
	['a contradicted claim', (r) => { r.verdict = 'FAIL'; }],
	['a different command', (r) => { r.observed.command = 'echo pass'; }],
	['inconsistent totals', (r) => { r.observed.totals.passed = 1; }],
	['an invalid timestamp', (r) => { r.generatedAt = 'invalid'; }]
]) test(`rejects ${name} rather than allowing an upstream green job`, () => {
	const r = receipt(); change(r);
	assert.throws(() => verifyReceipt(r, context));
});

test('blocks review findings without claiming they are approved', () => {
	const r = receipt(); r.verdict = 'NEEDS_HUMAN';
	r.discrepancies = [{ check: 'C4', severity: 'needs-human', summary: 'CI edited' }];
	assert.throws(() => verifyReceipt(r, context), /owner review.*C4.*CI edited/);
});

for (const target of ['receipt', 'report']) test(`malformed ${target} fails the CLI with file context`, () => {
	const dir = mkdtempSync(resolve(tmpdir(), 'meg-json-'));
	try {
		writeFileSync(resolve(dir, 'receipt.json'), JSON.stringify(receipt()));
		writeFreshReport(resolve(dir, 'report.json'), JSON.stringify({ testResults: [{ assertionResults: [
			{ status: 'passed' }, { status: 'passed' }
		] }] }));
		(target === 'report' ? writeFreshReport : writeFileSync)(resolve(dir, `${target}.json`), '{invalid');
		writeFileSync(resolve(dir, 'start.txt'), context.startedAt);
		const run = spawnSync(process.execPath, [new URL('../verify.mjs', import.meta.url).pathname,
			resolve(dir, 'receipt.json'), resolve(dir, 'report.json'), resolve(dir, 'start.txt')],
		{ env: { ...process.env, MEG_HEAD_SHA: context.headSha, MEG_BASE_SHA: context.baseSha,
			MEG_RECEIPT_SHA256: digest(resolve(dir, 'receipt.json')) }, encoding: 'utf8' });
		assert.equal(run.status, 1);
		assert(run.stderr.includes('invalid JSON in ' + target), run.stderr);
		assert.doesNotMatch(run.stdout, /verified/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('malformed manifest fails preparation with file context', () => {
	const dir = mkdtempSync(resolve(tmpdir(), 'meg-manifest-'));
	try {
		writeFileSync(resolve(dir, 'package.json'), '{invalid');
		const run = spawnSync(process.execPath, [new URL('../prepare.mjs', import.meta.url).pathname],
			{ cwd: dir, encoding: 'utf8' });
		assert.notEqual(run.status, 0);
		assert.match(run.stderr, /invalid JSON in package.json/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fixture harness refuses arbitrary tool and output CLI paths', () => {
	const run = spawnSync(process.execPath, [new URL('../examples.mjs', import.meta.url).pathname, resolve(tmpdir(), 'untrusted'), resolve(tmpdir(), 'output')], { encoding: 'utf8' });
	assert.notEqual(run.status, 0);
	assert.match(run.stderr, /does not accept CLI paths/);
});

function runVerifier(dir, headSha, baseSha) {
	return spawnSync(process.execPath, [new URL('../verify.mjs', import.meta.url).pathname,
		'receipt.json', 'report.json', 'start.txt'], { cwd: dir, encoding: 'utf8', env: { ...process.env,
		MEG_HEAD_SHA: headSha, MEG_BASE_SHA: baseSha, MEG_RECEIPT_SHA256: digest(resolve(dir, 'receipt.json')) } });
}

test('CLI independently verifies the diff and blocks changes to its own policy', () => {
	const dir = mkdtempSync(resolve(tmpdir(), 'meg-diff-'));
	const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: dir, encoding: 'utf8' }).trim();
	try {
		git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
		writeFileSync(resolve(dir, 'source.js'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
		const baseSha = git('rev-parse', 'HEAD');
		writeFileSync(resolve(dir, '.merge-evidence.yml'), 'severity: {}'); git('add', '.'); git('commit', '-qm', 'head');
		const headSha = git('rev-parse', 'HEAD');
		const r = receipt(); r.pr.head_sha = headSha; r.pr.base_sha = baseSha;
		writeFileSync(resolve(dir, 'receipt.json'), JSON.stringify(r));
		writeFreshReport(resolve(dir, 'report.json'), JSON.stringify({ testResults: [{ assertionResults: [{ status: 'passed' }, { status: 'passed' }] }] }));
		writeFileSync(resolve(dir, 'start.txt'), context.startedAt);
		const run = runVerifier(dir, headSha, baseSha);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /owner review.*\.merge-evidence.yml/);
		// The same syntactically valid receipt cannot pass outside its checkout.
		git('checkout', '--detach', '-q', baseSha);
		const wrong = runVerifier(dir, headSha, baseSha);
		assert.equal(wrong.status, 1);
		assert.match(wrong.stderr, /checkout.*revision/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('requires freshly written per-test results that agree with the receipt', () => {
	const dir = mkdtempSync(resolve(tmpdir(), 'meg-report-'));
	try {
		const receiptPath = resolve(dir, 'receipt.json'); const reportPath = resolve(dir, 'report.json');
		writeFileSync(receiptPath, JSON.stringify(receipt()));
		writeFreshReport(reportPath, JSON.stringify({ testResults: [{ assertionResults: [
			{ fullName: 'first', status: 'passed' }, { fullName: 'second', status: 'passed' }
		] }] }));
		const execution = { ...context, receiptSha256: digest(receiptPath) };
		assert.throws(() => verifyFiles(receiptPath, reportPath, context), /receipt digest/);
		assert.throws(() => verifyFiles(receiptPath, reportPath, { ...execution, receiptSha256: '0'.repeat(64) }), /receipt digest/);
		assert.doesNotThrow(() => verifyFiles(receiptPath, reportPath, execution));
		utimesSync(reportPath, new Date('2026-10-08'), new Date('2026-10-08'));
		assert.throws(() => verifyFiles(receiptPath, reportPath, execution), /fresh report/);
		writeFreshReport(reportPath, JSON.stringify({ testResults: [] }));
		assert.throws(() => verifyFiles(receiptPath, reportPath, execution), /count mismatch/);
		writeFreshReport(reportPath, JSON.stringify({ testResults: [{ assertionResults: [
			{ fullName: 'first', status: 'passed' }, { fullName: 'second', status: 'failed' }
		] }] }));
		assert.throws(() => verifyFiles(receiptPath, reportPath, execution), /outcomes disagree/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preparation removes stale artifacts and refuses a narrowed npm test script', () => {
	const dir = mkdtempSync(resolve(tmpdir(), 'meg-prepare-'));
	const prepare = new URL('../prepare.mjs', import.meta.url);
	try {
		writeFileSync(resolve(dir, 'receipt.json'), 'old');
		writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run one.test.js' } }));
		const rejected = spawnSync(process.execPath, [prepare.pathname], { cwd: dir, env: { ...process.env, GITHUB_WORKSPACE: dir }, encoding: 'utf8' });
		assert.notEqual(rejected.status, 0, 'narrowing the actual command must block the gate');
		assert.match(rejected.stderr, /vitest run/);
		writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
		const accepted = spawnSync(process.execPath, [prepare.pathname], { cwd: dir, env: { ...process.env, GITHUB_WORKSPACE: dir }, encoding: 'utf8' });
		assert.equal(accepted.status, 0, accepted.stderr);
		assert.throws(() => readFileSync(resolve(dir, 'receipt.json')), /ENOENT/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const scenario of ['renamed policy', 'large ordinary patch', 'missing base diagnostic']) test(`checkout handles ${scenario}`, () => {
	const dir = mkdtempSync(resolve(tmpdir(), 'meg-checkout-'));
	const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: dir, encoding: 'utf8' }).trim();
	try {
		git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
		writeFileSync(resolve(dir, '.merge-evidence.yml'), 'severity: {}'); git('add', '.'); git('commit', '-qm', 'base');
		const baseSha = git('rev-parse', 'HEAD');
		if (scenario === 'renamed policy') git('mv', '.merge-evidence.yml', 'ordinary.yml');
		else writeFileSync(resolve(dir, 'ordinary.txt'), scenario === 'large ordinary patch' ? 'ordinary line\n'.repeat(5_000_000) : 'ordinary line\n');
		git('add', '.'); git('commit', '-qm', 'head');
		const revisions = { baseSha, headSha: git('rev-parse', 'HEAD') };
		if (scenario === 'renamed policy') assert.throws(() => verifyCheckout(revisions, dir), /owner review.*\.merge-evidence.yml/);
		else if (scenario === 'missing base diagnostic') {
			assert.throws(() => verifyCheckout({ ...revisions, baseSha: 'f'.repeat(40) }, dir),
				/PR diff could not be independently verified: fatal: Not a valid commit name f{40}/);
		} else assert.doesNotThrow(() => verifyCheckout(revisions, dir));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runtime skips require owner review even when other tests pass', () => {
	const r = receipt(); r.observed.totals = { run: 2, passed: 1, failed: 0, skipped: 1 };
	assert.throws(() => verifyReceipt(r, context), /owner review.*skipped/);
});
