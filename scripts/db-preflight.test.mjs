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
//
// Behavior tests for db-preflight.mjs. The script exists because drizzle-kit
// exits 1 with no output on connection failures (2026-09-17: an expired Turso
// token cost a full deploy-debug cycle on a silent spinner). These tests pin
// the contract: a usable database exits 0, and ANY failure exits non-zero with
// the underlying driver error on stderr — never silently.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
