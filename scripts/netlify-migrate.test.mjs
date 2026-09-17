// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

// Behavior tests for netlify-migrate.mjs. The real drizzle-kit bin, the
// real verification script, and the real database preflight are replaced via
// the script's documented test-only seams (MODERATY_DRIZZLE_KIT_BIN /
// MODERATY_VERIFY_BIN / MODERATY_PREFLIGHT_BIN) with fake node scripts that
// record every invocation and can be told to fail, so the gate's own logic —
// the CONTEXT decision, run order, and loud failure propagation — is exercised
// end to end without touching a database. Every test fails if the script's
// real logic breaks (e.g. running the migration on a preview build, or
// ignoring a failure).

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./netlify-migrate.mjs', import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), 'netlify-migrate-test-'));
const gateLog = join(tmp, 'gate-calls.log');

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

// The fake drizzle-kit bin: records the invocation, fails when told to.
const fakeDrizzle = join(tmp, 'fake-drizzle-kit.cjs');
writeFileSync(
	fakeDrizzle,
	`require('node:fs').appendFileSync(process.env.GATE_LOG, 'db:migrate\\n');
if (process.env.GATE_FAIL === 'migrate') {
  console.error('fake drizzle-kit: migrate failed');
  process.exit(1);
}
`
);

// The fake database preflight: records the invocation, fails when told to.
const fakePreflight = join(tmp, 'fake-preflight.cjs');
writeFileSync(
	fakePreflight,
	`require('node:fs').appendFileSync(process.env.GATE_LOG, 'db:preflight\\n');
if (process.env.GATE_FAIL === 'preflight') {
  console.error('fake preflight: cannot reach the database — SERVER_ERROR: Server returned HTTP status 401');
  process.exit(1);
}
`
);

// The fake verification script: records the invocation, fails when told to.
const fakeVerify = join(tmp, 'fake-verify.cjs');
writeFileSync(
	fakeVerify,
	`require('node:fs').appendFileSync(process.env.GATE_LOG, 'db:verify\\n');
if (process.env.GATE_FAIL === 'verify') {
  console.error('fake verify: verification failed');
  process.exit(1);
}
`
);

function runGate(env) {
	return execFileAsync('node', [SCRIPT], {
		env: {
			...process.env,
			GATE_LOG: gateLog,
			MODERATY_DRIZZLE_KIT_BIN: fakeDrizzle,
			MODERATY_VERIFY_BIN: fakeVerify,
			MODERATY_PREFLIGHT_BIN: fakePreflight,
			// Preflight needs database credentials; explicit `env` overrides win.
			TURSO_DATABASE_URL: 'https://db.example.turso.io',
			TURSO_AUTH_TOKEN: 'test-token',
			...env
		}
	});
}

function logLines() {
	if (!existsSync(gateLog)) return [];
	return readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean);
}

describe('netlify-migrate', () => {
	beforeEach(() => {
		rmSync(gateLog, { force: true });
	});

	it('skips migration on deploy-preview builds and never invokes a command', async () => {
		const { stdout } = await runGate({ CONTEXT: 'deploy-preview', GATE_FAIL: 'migrate' });
		expect(stdout).toContain('skipping migrations');
		expect(logLines()).toEqual([]);
	});

	it('runs db:migrate then db:verify on production builds and proceeds', async () => {
		const { stdout } = await runGate({ CONTEXT: 'production' });
		expect(logLines()).toEqual(['db:preflight', 'db:migrate', 'db:verify']);
		expect(stdout).toContain('migrations applied and verified — proceeding');
	});

	it('runs migrations on branch-deploy builds (dev branch deploys migrate dev-2)', async () => {
		const { stdout } = await runGate({ CONTEXT: 'branch-deploy' });
		expect(logLines()).toEqual(['db:preflight', 'db:migrate', 'db:verify']);
		expect(stdout).toContain('proceeding with the build');
	});

	it('runs migrations when CONTEXT is unset (conservative default, never a silent skip)', async () => {
		const { stdout } = await runGate({});
		expect(stdout).toContain('CONTEXT=(unset)');
		expect(logLines()).toEqual(['db:preflight', 'db:migrate', 'db:verify']);
	});

	it('blocks the build loudly when db:preflight fails, surfacing the real error and never invoking drizzle-kit', async () => {
		// 2026-09-17 Coolify dev deploy: an expired TURSO_AUTH_TOKEN made Turso
		// answer 401, drizzle-kit swallowed the error and exited 1 silently —
		// the deploy log showed only a spinner. The preflight runs first so the
		// REAL error reaches the log, and nothing downstream runs.
		try {
			await runGate({ CONTEXT: 'production', GATE_FAIL: 'preflight' });
			expect.unreachable('an unreachable database must block the build');
		} catch (error) {
			expect(error.code).toBe(1);
			expect(logLines()).toEqual(['db:preflight']);
			const out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
			expect(out).toContain('HTTP status 401');
			expect(out).toContain('db:preflight failed');
			expect(out).toContain('blocking the deploy');
		}
	});

	it('blocks the build loudly when db:migrate fails', async () => {
		try {
			await runGate({ CONTEXT: 'production', GATE_FAIL: 'migrate' });
			expect.unreachable('a failed migration must block the build');
		} catch (error) {
			expect(error.code).toBe(1);
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('db:migrate failed');
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('blocking the deploy');
		}
	});

	it('blocks the build loudly when db:migrate passes but db:verify fails', async () => {
		try {
			await runGate({ CONTEXT: 'production', GATE_FAIL: 'verify' });
			expect.unreachable('an unverified schema must block the build');
		} catch (error) {
			expect(error.code).toBe(1);
			// Both steps ran — the failure is specifically the verification.
			expect(logLines()).toEqual(['db:preflight', 'db:migrate', 'db:verify']);
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('db:verify failed');
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('blocking the deploy');
		}
	});

	it('never runs db:verify before db:migrate — order is preflight, migrate, then verify', async () => {
		// Covers a regression where verification could be skipped or reordered.
		await runGate({ CONTEXT: 'production' });
		expect(logLines()).toEqual(['db:preflight', 'db:migrate', 'db:verify']);
	});

	it('blocks the build with an actionable message when TURSO_DATABASE_URL never reached the build', async () => {
		// Coolify symptom (2026-08-19 prod deploy): "Use Docker Build Secrets"
		// off => the secret mounts are empty => drizzle.config.ts throws a bare
		// "TURSO_DATABASE_URL is required". The gate must preflight with a
		// message that names the operator fix, and must NOT run any command.
		try {
			await runGate({ CONTEXT: 'production', TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '' });
			expect.unreachable('a build without TURSO_DATABASE_URL must be blocked');
		} catch (error) {
			expect(error.code).toBe(1);
			expect(logLines()).toEqual([]);
			const out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
			expect(out).toContain('TURSO_DATABASE_URL is not set');
			expect(out).toContain('Use Docker Build Secrets');
			expect(out).toContain('Environment Variables');
			expect(out).toContain('blocking the deploy');
		}
	});

	it('blocks the build when TURSO_AUTH_TOKEN is missing for a remote database', async () => {
		try {
			await runGate({ CONTEXT: 'production', TURSO_AUTH_TOKEN: '' });
			expect.unreachable('a remote database without a token must be blocked');
		} catch (error) {
			expect(error.code).toBe(1);
			expect(logLines()).toEqual([]);
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('TURSO_AUTH_TOKEN is not set');
		}
	});

	it('allows file: database URLs without a token (local development)', async () => {
		const { stdout } = await runGate({ CONTEXT: 'production', TURSO_DATABASE_URL: 'file:./local.db', TURSO_AUTH_TOKEN: '' });
		expect(logLines()).toEqual(['db:preflight', 'db:migrate', 'db:verify']);
		expect(stdout).toContain('migrations applied and verified');
	});

	it('never applies the env preflight to deploy-preview builds (they skip SQL entirely)', async () => {
		const { stdout } = await runGate({ CONTEXT: 'deploy-preview', TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '' });
		expect(stdout).toContain('skipping migrations');
		expect(logLines()).toEqual([]);
	});
});
