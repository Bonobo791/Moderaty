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

// Behavior tests for verify-migrations.mjs. Each test builds a temp
// drizzle-style journal + SQL files and a temp SQLite database whose
// __drizzle_migrations rows mirror what drizzle-kit records, then runs the
// real script against them. The script must exit 0 only when every journal
// entry's sha256 is applied — a verification that passes on a missing
// migration, or fails on a fully migrated database, is a broken test.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./verify-migrations.mjs', import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), 'verify-migrations-test-'));
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const SQL_0000 = 'CREATE TABLE channels (id TEXT PRIMARY KEY);\n';
const SQL_0001 = 'ALTER TABLE channels ADD COLUMN title TEXT;\n';

const hashOf = (sql) => createHash('sha256').update(sql).digest('hex');

/** Writes a temp drizzle/ meta dir with _journal.json and the two SQL files. */
function writeJournal(metaDir, { tags = ['0000_first', '0001_second'] } = {}) {
	mkdirSync(metaDir, { recursive: true });
	writeFileSync(
		join(metaDir, '_journal.json'),
		JSON.stringify({
			version: '6',
			dialect: 'turso',
			entries: tags.map((tag, idx) => ({ idx, version: '6', when: 1785326400000 + idx, tag, breakpoints: true }))
		})
	);
	// The SQL files live next to meta/, exactly like drizzle/ layout.
	writeFileSync(join(metaDir, '..', '0000_first.sql'), SQL_0000);
	writeFileSync(join(metaDir, '..', '0001_second.sql'), SQL_0001);
}

/** Builds a temp sqlite database pre-loaded with __drizzle_migrations rows for `hashes`. */
async function buildDb(name, hashes) {
	const url = `file:${join(tmp, name)}`;
	const client = createClient({ url });
	await client.execute('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at INTEGER)');
	for (const hash of hashes) {
		await client.execute({ sql: 'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)', args: [hash, 1785326400000] });
	}
	client.close();
	return url;
}

/** Runs the script against `url` with a temp meta dir; returns exit code + stdout (stderr merged, since the script reports failures on stderr). */
async function runVerify(url, metaDir) {
	const { TURSO_AUTH_TOKEN: _token, TURSO_DATABASE_URL: _url, ...rest } = process.env;
	try {
		const { stdout } = await execFileAsync('node', [SCRIPT, metaDir], { env: { ...rest, TURSO_DATABASE_URL: url } });
		return { code: 0, stdout };
	} catch (error) {
		return { code: error.code ?? 1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` };
	}
}

describe('verify-migrations', () => {
	it('passes when every journal entry is applied, and names the full range', async () => {
		const metaDir = join(tmp, 'all-applied', 'meta');
		writeJournal(metaDir);
		const url = await buildDb('all-applied.db', [hashOf(SQL_0000), hashOf(SQL_0001)]);
		const { code, stdout } = await runVerify(url, metaDir);
		expect(code).toBe(0);
		expect(stdout).toContain('PASS — all 2 migrations applied (0000_first … 0001_second)');
	});

	it('fails loudly and names the missing migration when one journal entry is unapplied', async () => {
		const metaDir = join(tmp, 'missing-second', 'meta');
		writeJournal(metaDir);
		const url = await buildDb('missing-second.db', [hashOf(SQL_0000)]);
		const { code, stdout } = await runVerify(url, metaDir);
		expect(code).toBe(1);
		expect(stdout).toContain('MISSING 0001_second');
		expect(stdout).toContain('FAIL — 1 missing');
	});

	it('fails loudly on a fresh database with no __drizzle_migrations table', async () => {
		const metaDir = join(tmp, 'fresh', 'meta');
		writeJournal(metaDir);
		const url = `file:${join(tmp, 'fresh.db')}`;
		// No table created on purpose — the script must report every journal
		// entry as unapplied (migrate first), never pass on an empty result.
		const { code, stdout } = await runVerify(url, metaDir);
		expect(code).toBe(1);
		expect(stdout).toContain('__drizzle_migrations does not exist');
		expect(stdout).toContain('MISSING 0000_first');
		expect(stdout).toContain('MISSING 0001_second');
	});

	it('fails loudly when the database drifted: an applied hash with no journal entry', async () => {
		const metaDir = join(tmp, 'drifted', 'meta');
		writeJournal(metaDir);
		const url = await buildDb('drifted.db', [hashOf(SQL_0000), hashOf(SQL_0001), 'deadbeef'.repeat(8)]);
		const { code, stdout } = await runVerify(url, metaDir);
		expect(code).toBe(1);
		expect(stdout).toContain('EXTRA applied hash deadbeefdead… has no journal entry');
		expect(stdout).toContain('FAIL — 0 missing, 1 extra');
	});

	it('fails loudly when a migration file was edited after being applied (hash drift)', async () => {
		// The journal and file now hash to the NEW content, but the database
		// still records the OLD hash — exactly the situation a silent no-op
		// migrate would leave behind. The entry must read as MISSING.
		const metaDir = join(tmp, 'edited', 'meta');
		writeJournal(metaDir);
		const url = await buildDb('edited.db', [hashOf(SQL_0000), hashOf(`${SQL_0001}-- old\n`)]);
		const { code, stdout } = await runVerify(url, metaDir);
		expect(code).toBe(1);
		expect(stdout).toContain('MISSING 0001_second');
	});

	it('passes trivially on an empty journal (nothing to verify)', async () => {
		const metaDir = join(tmp, 'empty-journal', 'meta');
		writeJournal(metaDir, { tags: [] });
		const url = await buildDb('empty-journal.db', []);
		const { code, stdout } = await runVerify(url, metaDir);
		expect(code).toBe(0);
		expect(stdout).toContain('PASS — journal has no entries to verify');
	});

	it('fails loudly and early when TURSO_DATABASE_URL is missing', async () => {
		const metaDir = join(tmp, 'no-url', 'meta');
		writeJournal(metaDir);
		const { TURSO_AUTH_TOKEN: _token, TURSO_DATABASE_URL: _url, ...rest } = process.env;
		try {
			await execFileAsync('node', [SCRIPT, metaDir], { env: rest });
			expect.unreachable('script must fail without TURSO_DATABASE_URL');
		} catch (error) {
			expect(error.code).toBe(1);
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('TURSO_DATABASE_URL is not set');
		}
	});

	it('fails loudly and early when the journal file is missing', async () => {
		const metaDir = join(tmp, 'no-journal', 'meta');
		mkdirSync(metaDir, { recursive: true });
		const url = await buildDb('no-journal.db', []);
		const { code, stdout } = await runVerify(url, metaDir);
		expect(code).toBe(1);
		expect(stdout).toContain(`no journal at ${metaDir}/_journal.json`);
	});

	it('fails loudly and early when a journal tag has no SQL file', async () => {
		const metaDir = join(tmp, 'broken-journal', 'meta');
		mkdirSync(metaDir, { recursive: true });
		writeFileSync(
			join(metaDir, '_journal.json'),
			JSON.stringify({ version: '6', dialect: 'turso', entries: [{ idx: 0, version: '6', when: 1, tag: '0000_first', breakpoints: true }] })
		);
		// Deliberately no 0000_first.sql — the journal references a missing file.
		const url = await buildDb('broken-journal.db', []);
		const { code, stdout } = await runVerify(url, metaDir);
		expect(code).toBe(1);
		expect(stdout).toContain('refusing to verify a broken journal');
	});

	it('aborts loudly when the database cannot be reached at all (no false PASS)', async () => {
		const metaDir = join(tmp, 'unreachable', 'meta');
		writeJournal(metaDir);
		const { TURSO_AUTH_TOKEN: _token, TURSO_DATABASE_URL: _url, ...rest } = process.env;
		try {
			await execFileAsync('node', [SCRIPT, metaDir], {
				env: { ...rest, TURSO_DATABASE_URL: 'http://127.0.0.1:1', TURSO_AUTH_TOKEN: 'test-token' }
			});
			expect.unreachable('unreachable database must fail');
		} catch (error) {
			expect(error.code).toBe(1);
			expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain('cannot read __drizzle_migrations');
		}
	});
});
