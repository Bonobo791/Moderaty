import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseJson, readJson } from './json.mjs';
import { verifyCheckout } from './checkout.mjs';

export const TEST_COMMAND = 'npm test -- --reporter=json --outputFile=.merge-evidence/vitest-results.json';

function requireEvidence(condition, message) {
	if (!condition) throw new Error(`Merge evidence rejected: ${message}`);
}

export function verifyReceipt(receipt, { headSha, baseSha, startedAt }) {
	requireEvidence(receipt?.schema === 'merge-evidence/receipt/v1', 'invalid receipt schema');
	requireEvidence(receipt.pr?.head_sha === headSha && receipt.pr?.base_sha === baseSha, 'revision mismatch');
	const start = Date.parse(startedAt);
	const generated = Date.parse(receipt.generatedAt);
	requireEvidence(Number.isFinite(start) && Number.isFinite(generated) && generated >= Math.floor(start / 1000) * 1000,
		'receipt predates this execution or has an invalid timestamp');
	verifyExecution(receipt.observed);
	verifyDiff(receipt.diff);
	requireEvidence(Array.isArray(receipt.discrepancies) && !receipt.discrepancies.some((d) => d.severity === 'fail'),
		'failing or missing discrepancy list');
	verifyVerdict(receipt);
	return receipt.discrepancies;
}

function verifyVerdict(receipt) {
	const review = receipt.discrepancies.filter((d) => d.severity === 'needs-human');
	requireEvidence(receipt.verdict !== 'NEEDS_HUMAN' && review.length === 0,
		'owner review required: ' + review.map((d) => d.check + ': ' + d.summary).join('; '));
	requireEvidence(receipt.verdict === 'PASS', `verdict is ${receipt.verdict}`);
}

function verifyExecution(observed) {
	requireEvidence(observed && (observed.source === undefined || observed.source === 'run'), 'tests were not executed');
	requireEvidence(!observed.no_evidence && !observed.no_test_command, 'no usable execution evidence');
	requireEvidence(observed.command === TEST_COMMAND, 'the full approved test command did not run');
	requireEvidence(observed.exit_code === 0, `test process exited ${observed.exit_code}`);
	const totals = observed.totals;
	requireEvidence(totals && ['run', 'passed', 'failed', 'skipped'].every((key) =>
		Number.isSafeInteger(totals[key]) && totals[key] >= 0), 'invalid test totals');
	requireEvidence(totals.run > 0 && totals.passed > 0 && totals.failed === 0,
		'no tests passed, or assertions failed');
	requireEvidence(totals.skipped === 0, 'owner review required: execution skipped tests');
	requireEvidence(totals.run === totals.passed + totals.failed + totals.skipped, 'inconsistent test totals');
}

function verifyDiff(diff) {
	// The pinned receipt schema omits unreliable when the diff is reliable.
	const lists = [diff?.tests?.added, diff?.tests?.deleted, diff?.tests?.skipped_added,
		diff?.tests?.focused, diff?.sensitive_paths, diff?.lockfiles, diff?.snapshots];
	requireEvidence(diff && diff.unreliable !== true && lists.every((list) =>
		Array.isArray(list) && list.every((path) => typeof path === 'string')), 'PR diff could not be verified');
}

export function verifyFiles(receiptPath, reportPath, context) {
	const reportStat = statSync(reportPath);
	requireEvidence(reportStat.isFile() && reportStat.size > 0 && reportStat.mtimeMs >= Date.parse(context.startedAt),
		'the runner did not write a fresh report');
	const bytes = readFileSync(receiptPath);
	requireEvidence(/^[a-f0-9]{64}$/.test(context.receiptSha256 ?? '') &&
		createHash('sha256').update(bytes).digest('hex') === context.receiptSha256, 'missing or mismatched action receipt digest');
	const receipt = parseJson(bytes.toString('utf8'), 'receipt');
	const findings = verifyReceipt(receipt, context);
	const report = readJson(reportPath, 'report');
	const assertions = report.testResults?.flatMap((file) => file.assertionResults ?? []);
	requireEvidence(Array.isArray(assertions) && assertions.length === receipt.observed.totals.run, 'raw report/receipt count mismatch');
	requireEvidence(assertions.filter((test) => test.status === 'passed').length === receipt.observed.totals.passed &&
		assertions.every((test) => test.status === 'passed'), 'raw report/receipt outcomes disagree');
	return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const [receiptPath, reportPath, startPath] = process.argv.slice(2);
		const findings = verifyFiles(receiptPath, reportPath, {
			headSha: process.env.MEG_HEAD_SHA, baseSha: process.env.MEG_BASE_SHA,
			receiptSha256: process.env.MEG_RECEIPT_SHA256,
			startedAt: readFileSync(startPath, 'utf8').trim()
		});
		verifyCheckout({ headSha: process.env.MEG_HEAD_SHA, baseSha: process.env.MEG_BASE_SHA });
		for (const finding of findings) console.warn(`REVIEW REQUIRED: ${finding.check}: ${finding.summary}`);
		console.info('Fresh test execution verified; no blocking gate findings.');
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
