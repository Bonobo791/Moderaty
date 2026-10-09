import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyFiles, verifyReceipt } from './verify.mjs';

const context = { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), startedAt: '2026-10-09T12:00:00Z' };
const receipt = () => ({
	schema: 'merge-evidence/receipt/v1', generatedAt: '2026-10-09T12:00:01Z',
	pr: { head_sha: context.headSha, base_sha: context.baseSha },
	observed: { command: 'npm test -- --reporter=json --outputFile=.merge-evidence/vitest-results.json',
		exit_code: 0, totals: { run: 2, passed: 2, failed: 0, skipped: 0 } },
	diff: {}, verdict: 'PASS', discrepancies: []
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
	['a neutral abstention', (r) => { r.verdict = 'NEUTRAL'; }],
	['a contradicted claim', (r) => { r.verdict = 'FAIL'; }],
	['a different command', (r) => { r.observed.command = 'echo pass'; }],
	['inconsistent totals', (r) => { r.observed.totals.passed = 1; }],
	['an invalid timestamp', (r) => { r.generatedAt = 'invalid'; }]
]) test(`rejects ${name} rather than allowing an upstream green job`, () => {
	const r = receipt(); change(r);
	assert.throws(() => verifyReceipt(r, context));
});

test('preserves explicit review findings without claiming they are approved', () => {
	const r = receipt(); r.verdict = 'NEEDS_HUMAN';
	r.discrepancies = [{ check: 'C4', severity: 'needs-human', summary: 'CI edited' }];
	assert.deepEqual(verifyReceipt(r, context), r.discrepancies);
});

test('requires freshly written per-test results that agree with the receipt', () => {
	const dir = mkdtempSync(resolve(tmpdir(), 'meg-report-'));
	try {
		const receiptPath = resolve(dir, 'receipt.json'); const reportPath = resolve(dir, 'report.json');
		writeFileSync(receiptPath, JSON.stringify(receipt()));
		writeFileSync(reportPath, JSON.stringify({ testResults: [{ assertionResults: [
			{ fullName: 'first', status: 'passed' }, { fullName: 'second', status: 'passed' }
		] }] }));
		assert.doesNotThrow(() => verifyFiles(receiptPath, reportPath, context));
		utimesSync(reportPath, new Date('2026-10-08'), new Date('2026-10-08'));
		assert.throws(() => verifyFiles(receiptPath, reportPath, context), /fresh report/);
		writeFileSync(reportPath, JSON.stringify({ testResults: [] }));
		assert.throws(() => verifyFiles(receiptPath, reportPath, context), /count mismatch/);
		writeFileSync(reportPath, JSON.stringify({ testResults: [{ assertionResults: [
			{ fullName: 'first', status: 'passed' }, { fullName: 'second', status: 'failed' }
		] }] }));
		assert.throws(() => verifyFiles(receiptPath, reportPath, context), /outcomes disagree/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preparation removes stale artifacts and refuses a narrowed npm test script', () => {
	const dir = mkdtempSync(resolve(tmpdir(), 'meg-prepare-'));
	const prepare = new URL('./prepare.mjs', import.meta.url);
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
