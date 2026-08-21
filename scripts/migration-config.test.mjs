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

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { loadMigrationConfig } from './migration-config.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'reconcile-migrations.mjs');

describe('loadMigrationConfig (shared by the migration CLI scripts)', () => {
	test('resolves the default meta dir and journal path for a remote DB', () => {
		const cfg = loadMigrationConfig({ argv: [], env: { TURSO_DATABASE_URL: 'libsql://example.turso.io', TURSO_AUTH_TOKEN: 'tok' } });
		expect(cfg.url).toBe('libsql://example.turso.io');
		expect(cfg.journalPath.endsWith('drizzle/meta/_journal.json')).toBe(true);
	});

	test('accepts an explicit meta dir and skips the token requirement for file: URLs', () => {
		const cfg = loadMigrationConfig({ argv: ['custom/meta'], env: { TURSO_DATABASE_URL: 'file:local.db' } });
		expect(cfg.metaDir).toBe('custom/meta');
		expect(cfg.authToken).toBeUndefined();
	});

	test('the CLI exits 1 with a loud message when TURSO_DATABASE_URL is missing', async () => {
		const { TURSO_DATABASE_URL: _u, TURSO_AUTH_TOKEN: _t, ...rest } = process.env;
		await expect(execFileAsync('node', [SCRIPT], { env: rest })).rejects.toThrow(/TURSO_DATABASE_URL is not set/);
	});

	test('the CLI exits 1 with a loud message when the journal is missing', async () => {
		const { TURSO_DATABASE_URL: _u, TURSO_AUTH_TOKEN: _t, ...rest } = process.env;
		const tmp = mkdtempSync(join(tmpdir(), 'reconcile-no-journal-'));
		try {
			await expect(
				execFileAsync('node', [SCRIPT, tmp], { env: { ...rest, TURSO_DATABASE_URL: 'file:local.db' } })
			).rejects.toThrow(/no journal at/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('the CLI exits 1 with a loud message when the journal is malformed', async () => {
		const { TURSO_DATABASE_URL: _u, TURSO_AUTH_TOKEN: _t, ...rest } = process.env;
		const tmp = mkdtempSync(join(tmpdir(), 'reconcile-bad-journal-'));
		try {
			writeFileSync(join(tmp, '_journal.json'), '{ not json');
			await expect(
				execFileAsync('node', [SCRIPT, tmp], { env: { ...rest, TURSO_DATABASE_URL: 'file:local.db' } })
			).rejects.toThrow(/cannot read journal/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('the CLI exits 1 when more than one argv is supplied', async () => {
		const { TURSO_DATABASE_URL: _u, TURSO_AUTH_TOKEN: _t, ...rest } = process.env;
		await expect(
			execFileAsync('node', [SCRIPT, 'meta', 'extra'], { env: { ...rest, TURSO_DATABASE_URL: 'libsql://x.turso.io', TURSO_AUTH_TOKEN: 'tok' } })
		).rejects.toThrow(/Usage: node scripts\/reconcile-migrations\.mjs \[meta-dir\]/);
	});
});
