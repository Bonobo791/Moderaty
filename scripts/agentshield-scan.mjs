import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function exclusionReason(finding, root) {
	if (finding.file.startsWith('.stryker-tmp/')) return 'generated Stryker sandbox';
	if (finding.file === 'package-lock.json' && finding.id.startsWith('secrets-azure-key-')) {
		const line = readFileSync(join(root, finding.file), 'utf8').split('\n')[finding.line - 1];
		const hash = /^\s*"integrity": "sha512-([A-Za-z0-9/+]{86}==)"[,]?\s*$/.exec(line ?? '')?.[1];
		if (hash && finding.fix?.before === hash) return 'npm SHA-512 integrity hash';
	}
	if (finding.file === '.vscode/extensions.json' && ['permissions-no-block', 'hooks-no-pretooluse'].includes(finding.id)) {
		const config = JSON.parse(readFileSync(join(root, finding.file), 'utf8'));
		if (Object.keys(config).every(key => ['recommendations', 'unwantedRecommendations'].includes(key)) &&
			Object.values(config).every(value => Array.isArray(value) && value.every(item => typeof item === 'string'))) {
			return 'VS Code extension recommendations';
		}
	}
	if (['.agents/superpowers/hooks/hooks.json', '.agents/superpowers/hooks/hooks-cursor.json'].includes(finding.file) &&
		['hooks-no-pretooluse', 'hooks-no-stop-hooks'].includes(finding.id)) {
		const manifest = JSON.parse(readFileSync(join(root, '.agents/superpowers/.codex-plugin/plugin.json'), 'utf8'));
		if (JSON.stringify(manifest.hooks) === '{}') return 'vendor hooks explicitly disabled for Codex';
	}
	return null;
}

export function scan() {
	const root = fileURLToPath(new URL('../', import.meta.url));
	const directory = mkdtempSync(join(tmpdir(), 'moderaty-agentshield-'));
	const rawPath = join(directory, 'raw.json');
	const result = spawnSync(process.execPath, [join(root, 'node_modules/ecc-agentshield/dist/index.js'),
		'scan', '--path', root, '--format', 'json', '--output', rawPath], { encoding: 'utf8', timeout: 120_000 });
	if (result.error || result.signal || ![0, 2].includes(result.status)) {
		throw new Error(`AgentShield failed: ${result.error?.message ?? result.signal ?? (result.stderr || `exit ${result.status}`)}`);
	}
	const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
	if (!Array.isArray(raw.findings) || !Number.isInteger(raw.summary?.filesScanned) || raw.summary.filesScanned < 1) {
		throw new Error('AgentShield returned an invalid or empty scan report');
	}
	const findings = [];
	const excluded = [];
	for (const finding of raw.findings) {
		if (typeof finding.id !== 'string' || typeof finding.file !== 'string' || typeof finding.title !== 'string' ||
			!['critical', 'high', 'medium', 'low', 'info'].includes(finding.severity)) throw new Error('AgentShield returned an invalid finding');
		const reason = exclusionReason(finding, root);
		if (reason) excluded.push({ id: finding.id, file: finding.file, line: finding.line, reason });
		else findings.push(finding);
	}
	const reviewedPath = join(directory, 'reviewed.json');
	writeFileSync(reviewedPath, JSON.stringify({ filesScanned: raw.summary.filesScanned, findings, excluded }, null, 2) + '\n');
	console.info(`AgentShield: ${findings.length} remaining findings; ${excluded.length} verified false positives/artifact findings excluded.`);
	for (const finding of findings) console.warn(`${finding.severity}: ${finding.file}: ${finding.title}`.replace(/[\u0000-\u001f\u007f]/g, ''));
	console.info(`Raw report: ${rawPath}\nReviewed report: ${reviewedPath}`);
	return findings.some(finding => ['critical', 'high'].includes(finding.severity)) ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { process.exitCode = scan(); }
	catch (error) {
		console.error('AgentShield repository scan failed:', error.message);
		console.info('ERROR: AgentShield repository scan failed; inspect the diagnostic above.');
		process.exitCode = 1;
	}
}
