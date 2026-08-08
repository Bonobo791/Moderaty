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

// Behavior tests for netlify-migrate.mjs. The real `npm` is replaced by a
// PATH-stubbed fake that records every invocation and can be told to fail
// db:migrate or db:verify, so the gate's own logic — the CONTEXT decision,
// run order, and loud failure propagation — is exercised end to end without
// touching a database. Every test fails if the script's real logic breaks
// (e.g. running the migration on a preview build, or ignoring a failure).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./netlify-migrate.mjs', import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), 'netlify-migrate-test-'));
const binDir = join(tmp, 'bin');
const npmLog = join(tmp, 'npm-calls.log');
mkdirSync(binDir);

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

// The fake npm: appends its arguments to $NPM_LOG_FILE, and fails the script
// named by $NPM_FAIL ("migrate" or "verify") so the gate's failure
// propagation can be tested without a real database.
writeFileSync(
	join(binDir, 'npm'),
	`#!/bin/sh
echo "$*" >> "$NPM_LOG_FILE"
if [ "$NPM_FAIL" = "migrate" ] && [ "$1 $2" = "run db:migrate" ]; then
  echo "fake npm: db:migrate failed" >&2
  exit 1
fi
if [ "$NPM_FAIL" = "verify" ] && [ "$1 $2" = "run db:verify" ]; then
  echo "fake npm: db:verify failed" >&2
  exit 1
fi
exit 0
`,
	{ mode: 0o755 }
);

function runGate(env) {
	return execFileAsync('node', [SCRIPT], {
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH}`,
			NPM_LOG_FILE: npmLog,
			...env
		}
	});
}

function logLines() {
	if (!existsSync(npmLog)) return [];
	return readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean);
}

describe('netlify-migrate', () => {
	beforeEach(() => {
		rmSync(npmLog, { force: true });
	});

	it('skips migration on deploy-preview builds and never invokes npm', async () => {
		const { stdout } = await runGate({ CONTEXT: 'deploy-preview', NPM_FAIL: 'migrate' });
		expect(stdout).toContain('skipping migrations');
		expect(logLines()).toEqual([]);
	});

	it('runs db:migrate then db:verify on production builds and proceeds', async () => {
		const { stdout } = await runGate({ CONTEXT: 'production' });
		expect(logLines()).toEqual(['run db:migrate', 'run db:verify']);
		expect(stdout).toContain('migrations applied and verified — proceeding');
	});

	it('runs migrations on branch-deploy builds (dev branch deploys migrate dev-2)', async () => {
		const { stdout } = await runGate({ CONTEXT: 'branch-deploy' });
		expect(logLines()).toEqual(['run db:migrate', 'run db:verify']);
		expect(stdout).toContain('proceeding with the build');
	});

	it('runs migrations when CONTEXT is unset (conservative default, never a silent skip)', async () => {
		const { stdout } = await runGate({});
		expect(stdout).toContain('CONTEXT=(unset)');
		expect(logLines()).toEqual(['run db:migrate', 'run db:verify']);
	});

	it('blocks the build loudly when db:migrate fails', async () => {
		try {
			await runGate({ CONTEXT: 'production', NPM_FAIL: 'migrate' });
			expect.unreachable('a failed migration must block the build');
		} catch (error) {
			expect(error.code).toBe(1);
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('db:migrate failed');
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('blocking the deploy');
		}
	});

	it('blocks the build loudly when db:migrate passes but db:verify fails', async () => {
		try {
			await runGate({ CONTEXT: 'production', NPM_FAIL: 'verify' });
			expect.unreachable('an unverified schema must block the build');
		} catch (error) {
			expect(error.code).toBe(1);
			// Both steps ran — the failure is specifically the verification.
			expect(logLines()).toEqual(['run db:migrate', 'run db:verify']);
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('db:verify failed');
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('blocking the deploy');
		}
	});

	it('never runs the migration before db:verify — order is migrate, then verify', async () => {
		// Covers a regression where verification could be skipped or reordered.
		await runGate({ CONTEXT: 'production' });
		expect(logLines()).toEqual(['run db:migrate', 'run db:verify']);
	});
});
