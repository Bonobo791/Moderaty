import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const root = new URL('../..', import.meta.url);

test('an empty push diff exits cleanly under set -u', () => {
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	const input = `refs/heads/dev ${head} refs/heads/dev ${head}\n`;
	const result = spawnSync('bash', ['scripts/hooks/pre-push'], {
		cwd: root,
		input,
		encoding: 'utf8',
		env: { ...process.env, CODACY_GATE_OFF: '0' }
	});
	expect(result.status).toBe(0);
	expect(result.stderr).not.toContain('unbound variable');
	expect(result.stdout).toBe('');
});
