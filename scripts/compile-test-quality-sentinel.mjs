import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPILER = fileURLToPath(new URL('../.tools/gh-aw', import.meta.url));
const COMPILER_SHA256 = '1c74ff5fc28b1891d32b67f4348a9b7f750946b6d4a721e909187a848868016b';
const MASK_COMMAND = "printf '%s\\n' \"::add-mask::$MCP_GATEWAY_AGENT_ID\"";
const ORIGINAL_MASK = /^([ \t]*)echo "::add-mask::\$\{MCP_GATEWAY_AGENT_ID\}"$/gm;

export function normalizeGatewayMask(workflow) {
	const originalCount = [...workflow.matchAll(ORIGINAL_MASK)].length;
	const normalizedCount = workflow.split('\n').filter((line) => line.trim() === MASK_COMMAND).length;
	if (originalCount + normalizedCount !== 1) {
		throw new Error('Expected exactly one gateway masking command in compiled workflow');
	}
	return workflow.replace(ORIGINAL_MASK, (_, indent) => indent + MASK_COMMAND);
}

export function normalizeCodexWorkflow(workflow) {
	const metadata = JSON.parse(workflow.match(/^# gh-aw-metadata: (.+)$/m)?.[1] ?? '{}');
	if (metadata.agent_id !== 'codex') throw new Error('Expected a compiled Codex workflow');
	// The compiler adds a provider-independent OAuth check. Do not give it an unused Copilot secret.
	const normalized = normalizeGatewayMask(workflow)
		.replace(/^ +COPILOT_GITHUB_TOKEN: \$\{\{ secrets\.COPILOT_GITHUB_TOKEN \}\}\n/gm, '')
		.replace(/^#   - COPILOT_GITHUB_TOKEN\n/gm, '')
		.replace(/^# gh-aw-manifest: (.+)$/m, (_, json) => {
			const manifest = JSON.parse(json);
			manifest.secrets = manifest.secrets.filter((name) => name !== 'COPILOT_GITHUB_TOKEN');
			return '# gh-aw-manifest: ' + JSON.stringify(manifest);
		});
	if (normalized.includes('secrets.COPILOT_GITHUB_TOKEN')) throw new Error('Unexpected Copilot credential reference');
	return normalized;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length !== 2) throw new Error('Compiler path is fixed; no CLI arguments are accepted');
		if (!timingSafeEqual(createHash('sha256').update(readFileSync(COMPILER)).digest(), Buffer.from(COMPILER_SHA256, 'hex'))) {
			throw new Error('Compiler checksum differs from the reviewed gh-aw v0.89.21 binary');
		}
		execFileSync(COMPILER, ['compile', 'test-quality-sentinel', '--strict', '--action-mode', 'release',
			'--action-tag', 'c35393777e5604a63721d09512263b1383301d4f', '--no-check-update'], { stdio: 'inherit' });
		const path = '.github/workflows/test-quality-sentinel.lock.yml';
		writeFileSync(path, normalizeCodexWorkflow(readFileSync(path, 'utf8')));
		process.stdout.write('Normalized Codex workflow; gateway masked and unused Copilot secret omitted\n');
	} catch (error) {
		process.stderr.write('Sentinel compilation failed: ' + error.message + '\n');
		process.exitCode = 1;
	}
}
