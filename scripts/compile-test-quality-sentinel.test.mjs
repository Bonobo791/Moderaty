import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { normalizeGatewayMask } from './compile-test-quality-sentinel.mjs';

test('compiled masking preserves literal values and cannot execute shell content', () => {
	const workflow = readFileSync(new URL('../.github/workflows/test-quality-sentinel.lock.yml', import.meta.url), 'utf8');
	const original = workflow.replace(/^([ \t]*)printf.*MCP_GATEWAY_AGENT_ID.*$/m,
		(_, indent) => indent + 'echo "::add-mask::$' + '{MCP_GATEWAY_AGENT_ID}"');
	const normalized = normalizeGatewayMask(original);
	const line = normalized.split('\n').find((line) => line.includes('printf') && line.includes('MCP_GATEWAY_AGENT_ID'));
	expect(line).toBeDefined();
	const command = line.trim();
	const value = 'synthetic-$(exit 42)-`exit 43`-%s';
	const output = execFileSync('/bin/bash', ['--noprofile', '--norc', '-eu', '-c', command], {
		encoding: 'utf8', env: { PATH: '/usr/bin:/bin', MCP_GATEWAY_AGENT_ID: value }
	});
	expect(output).toBe('::add-mask::' + value + '\n');
	expect(normalizeGatewayMask(normalized)).toBe(normalized);
});

test('unexpected compiler masking output fails visibly instead of silently skipping normalization', () => {
	expect(() => normalizeGatewayMask('jobs: {}')).toThrow(/Expected exactly one gateway masking command/);
});


test.each(['../../etc/passwd', '/bin/sh', '$(exit 42)'])('compiler rejects caller-supplied paths: %s', (path) => {
	const result = spawnSync(process.execPath, ['scripts/compile-test-quality-sentinel.mjs', path], { encoding: 'utf8' });
	expect(result.status).toBe(1);
	expect(result.stderr).toContain('Compiler path is fixed; no CLI arguments are accepted');
});
