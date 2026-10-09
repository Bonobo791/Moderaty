import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { exclusionReason, scan } from './agentshield-scan.mjs';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const roots = [];
function fixture(file, content) {
	const root = mkdtempSync(join(tmpdir(), 'agentshield-test-'));
	roots.push(root);
	const path = join(root, file);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, content);
	return root;
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const hash = 'A'.repeat(86) + '==';
const finding = { id: 'secrets-azure-key-1', severity: 'critical', file: 'package-lock.json', line: 1, fix: { before: hash } };

test('an unexpected scanner exit without stderr fails with its exit code', () => {
	spawnSync.mockReturnValueOnce({ status: 99, stderr: '' });
	expect(() => scan()).toThrow('AgentShield failed: exit 99');
});

test('excludes only the matched npm integrity hash, retaining key findings elsewhere', () => {
	const root = fixture('package-lock.json', `"integrity": "sha512-${hash}",\n"azureKey": "${hash}"`);
	expect(exclusionReason(finding, root)).toBe('npm SHA-512 integrity hash');
	expect(exclusionReason({ ...finding, line: 2 }, root)).toBeNull();
	expect(exclusionReason({ ...finding, fix: { before: 'different-value' } }, root)).toBeNull();
	expect(exclusionReason({ ...finding, id: 'secrets-other' }, root)).toBeNull();
});

test('excludes generated Stryker copies, retaining findings in source tests', () => {
	expect(exclusionReason({ ...finding, file: '.stryker-tmp/sandbox/package-lock.json' }, '/tmp')).toBe('generated Stryker sandbox');
	expect(exclusionReason({ ...finding, file: 'src/settings.json', id: 'permissions-no-block' }, '/tmp')).toBeNull();
});

test('extension recommendations are not agent settings; executable configuration stays visible', () => {
	const root = fixture('.vscode/extensions.json', '{"recommendations":["svelte.svelte-vscode"]}');
	const warning = { id: 'permissions-no-block', severity: 'medium', file: '.vscode/extensions.json' };
	expect(exclusionReason(warning, root)).toBe('VS Code extension recommendations');
	expect(exclusionReason({ ...warning, id: 'secrets-other' }, root)).toBeNull();
	writeFileSync(join(root, warning.file), '{"recommendations":[],"hooks":{}}');
	expect(exclusionReason(warning, root)).toBeNull();
});

test('Codex-disabled vendor hooks omit only missing-hook policy suggestions', () => {
	const root = fixture('.agents/superpowers/.codex-plugin/plugin.json', '{"hooks":{}}');
	const warning = { id: 'hooks-no-pretooluse', file: '.agents/superpowers/hooks/hooks-cursor.json' };
	expect(exclusionReason(warning, root)).toBe('vendor hooks explicitly disabled for Codex');
	expect(exclusionReason({ ...warning, id: 'hooks-exfiltration' }, root)).toBeNull();
	writeFileSync(join(root, '.agents/superpowers/.codex-plugin/plugin.json'), '{"hooks":{"PreToolUse":[]}}');
	expect(exclusionReason(warning, root)).toBeNull();
});

test('the approved AgentShield repository command uses the exact locked dependency', () => {
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
	expect(manifest.scripts['scan:agents']).toBe('node scripts/agentshield-scan.mjs');
	expect(manifest.devDependencies['ecc-agentshield']).toBe('1.6.0');
	expect(lock.packages['node_modules/ecc-agentshield'].version).toBe('1.6.0');
});
