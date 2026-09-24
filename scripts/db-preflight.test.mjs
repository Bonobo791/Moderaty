// Behavior tests for db-preflight.mjs. The script exists because drizzle-kit
// exits 1 with no output on connection failures (2026-09-17: an expired Turso
// token cost a full deploy-debug cycle on a silent spinner). These tests pin
// the contract: a usable database exits 0, and ANY failure exits non-zero with
// the underlying driver error on stderr — never silently.

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./db-preflight.mjs', import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), 'db-preflight-test-'));

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function runPreflight(env) {
	return execFileAsync('node', [SCRIPT], { env: { ...process.env, ...env } });
}

describe('db-preflight', () => {
	it('exits 0 against a reachable database (file: URL)', async () => {
		const { stdout } = await runPreflight({
			TURSO_DATABASE_URL: `file:${join(tmp, 'preflight.db')}`,
			TURSO_AUTH_TOKEN: ''
		});
		expect(stdout).toContain('credentials accepted');
	});

	it('exits non-zero and prints the real driver error when the URL is malformed', async () => {
		try {
			await runPreflight({ TURSO_DATABASE_URL: 'not-a-url', TURSO_AUTH_TOKEN: '' });
			expect.unreachable('a malformed database URL must fail loudly');
		} catch (error) {
			expect(error.code).not.toBe(0);
			const stderr = `${error.stderr ?? ''}`;
			expect(stderr).toContain('db-preflight:');
			expect(stderr).toContain('URL_INVALID');
			expect(stderr).toContain('blocking the deploy');
			const stdout = `${error.stdout ?? ''}`;
			expect(stdout).not.toContain('db-preflight:');
		}
	});

	it('exits non-zero when reads work but writes are denied', async () => {
		// The write probe exists because a valid-but-read-only credential
		// passes SELECT 1 yet fails the migration's first write — the same
		// silent exit 1 this preflight was built to diagnose.
		const roPath = join(tmp, 'readonly.db');
		writeFileSync(roPath, '');
		chmodSync(roPath, 0o444);
		try {
			await runPreflight({
				TURSO_DATABASE_URL: `file:${roPath}`,
				TURSO_AUTH_TOKEN: ''
			});
			expect.unreachable('a read-only database must fail the write probe');
		} catch (error) {
			expect(error.code).not.toBe(0);
			const stderr = `${error.stderr ?? ''}`;
			expect(stderr).toContain('db-preflight:');
			expect(stderr).toContain('blocking the deploy');
			expect(stderr).toMatch(/read.only|READONLY/i);
		} finally {
			chmodSync(roPath, 0o644); // let rmSync remove it
		}
	});
});
