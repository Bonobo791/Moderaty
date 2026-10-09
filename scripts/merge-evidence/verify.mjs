import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
	const observed = receipt.observed;
	requireEvidence(observed && (observed.source === undefined || observed.source === 'run'), 'tests were not executed');
	requireEvidence(!observed.no_evidence && !observed.no_test_command, 'no usable execution evidence');
	requireEvidence(observed.command === TEST_COMMAND, 'the full approved test command did not run');
	requireEvidence(observed.exit_code === 0, `test process exited ${observed.exit_code}`);
	const totals = observed.totals;
	requireEvidence(totals && ['run', 'passed', 'failed', 'skipped'].every((key) =>
		Number.isSafeInteger(totals[key]) && totals[key] >= 0), 'invalid test totals');
	requireEvidence(totals.run > 0 && totals.passed > 0 && totals.failed === 0,
		'no tests passed, or assertions failed');
	requireEvidence(totals.run === totals.passed + totals.failed + totals.skipped, 'inconsistent test totals');
	requireEvidence(receipt.diff && receipt.diff.unreliable !== true, 'PR diff could not be verified');
	requireEvidence(['PASS', 'NEEDS_HUMAN'].includes(receipt.verdict), `verdict is ${receipt.verdict}`);
	requireEvidence(Array.isArray(receipt.discrepancies) && !receipt.discrepancies.some((d) => d.severity === 'fail'),
		'failing or missing discrepancy list');
	return receipt.discrepancies;
}

export function verifyFiles(receiptPath, reportPath, context) {
	const reportStat = statSync(reportPath);
	requireEvidence(reportStat.isFile() && reportStat.size > 0 && reportStat.mtimeMs >= Date.parse(context.startedAt),
		'the runner did not write a fresh report');
	const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
	const findings = verifyReceipt(receipt, context);
	const report = JSON.parse(readFileSync(reportPath, 'utf8'));
	const assertions = report.testResults?.flatMap((file) => file.assertionResults ?? []);
	requireEvidence(Array.isArray(assertions) && assertions.length === receipt.observed.totals.run, 'raw report/receipt count mismatch');
	requireEvidence(assertions.filter((test) => test.status === 'passed').length === receipt.observed.totals.passed &&
		assertions.every((test) => test.status !== 'failed'), 'raw report/receipt outcomes disagree');
	return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const [receiptPath, reportPath, startPath] = process.argv.slice(2);
		const findings = verifyFiles(receiptPath, reportPath, {
			headSha: process.env.MEG_HEAD_SHA, baseSha: process.env.MEG_BASE_SHA,
			startedAt: readFileSync(startPath, 'utf8').trim()
		});
		for (const finding of findings) console.warn(`REVIEW REQUIRED: ${finding.check}: ${finding.summary}`);
		console.info('Fresh test execution verified. Review findings still require owner approval.');
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
