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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length !== 2) throw new Error('Compiler path is fixed; no CLI arguments are accepted');
		if (!timingSafeEqual(createHash('sha256').update(readFileSync(COMPILER)).digest(), Buffer.from(COMPILER_SHA256, 'hex'))) {
			throw new Error('Compiler checksum differs from the reviewed gh-aw v0.89.21 binary');
		}
		execFileSync(COMPILER, ['compile', 'test-quality-sentinel', '--strict', '--action-mode', 'release',
			'--action-tag', 'c35393777e5604a63721d09512263b1383301d4f', '--no-check-update'], { stdio: 'inherit' });
		const path = '.github/workflows/test-quality-sentinel.lock.yml';
		writeFileSync(path, normalizeGatewayMask(readFileSync(path, 'utf8')));
		process.stdout.write('Normalized gateway masking command; credentials remain masked\n');
	} catch (error) {
		process.stderr.write('Sentinel compilation failed: ' + error.message + '\n');
		process.exitCode = 1;
	}
}
