// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// Behavior tests for netlify-migrate.mjs. The real drizzle-kit bin and the
// real verification script are replaced via the script's documented test-only
// seams (MODERATY_DRIZZLE_KIT_BIN / MODERATY_VERIFY_BIN) with fake node
// scripts that record every invocation and can be told to fail, so the gate's
// own logic — the CONTEXT decision, run order, and loud failure propagation —
// is exercised end to end without touching a database. Every test fails if
// the script's real logic breaks (e.g. running the migration on a preview
// build, or ignoring a failure).

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
		expect(logLines()).toEqual(['db:migrate', 'db:verify']);
		expect(stdout).toContain('migrations applied and verified — proceeding');
	});

	it('runs migrations on branch-deploy builds (dev branch deploys migrate dev-2)', async () => {
		const { stdout } = await runGate({ CONTEXT: 'branch-deploy' });
		expect(logLines()).toEqual(['db:migrate', 'db:verify']);
		expect(stdout).toContain('proceeding with the build');
	});

	it('runs migrations when CONTEXT is unset (conservative default, never a silent skip)', async () => {
		const { stdout } = await runGate({});
		expect(stdout).toContain('CONTEXT=(unset)');
		expect(logLines()).toEqual(['db:migrate', 'db:verify']);
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
			expect(logLines()).toEqual(['db:migrate', 'db:verify']);
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('db:verify failed');
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('blocking the deploy');
		}
	});

	it('never runs db:verify before db:migrate — order is migrate, then verify', async () => {
		// Covers a regression where verification could be skipped or reordered.
		await runGate({ CONTEXT: 'production' });
		expect(logLines()).toEqual(['db:migrate', 'db:verify']);
	});
});
