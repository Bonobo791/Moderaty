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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createClient } from '@libsql/client';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Reuse the real journal + migration files from the repo.
const metaDir = join(ROOT, 'drizzle', 'meta');
const journal = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf8'));
const entries = journal.entries ?? [];
const realHashes = entries.map((e) =>
	createHash('sha256').update(readFileSync(join(metaDir, '..', `${e.tag}.sql`))).digest('hex')
);

const tempDirs = [];
function tempDb() {
	const dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
	tempDirs.push(dir);
	return join(dir, 'drifted.db');
}
async function seededDb(dbPath, hashes) {
	const client = createClient({ url: `file:${dbPath}` });
	await client.execute('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)');
	for (let i = 0; i < hashes.length; i++) {
		await client.execute({ sql: 'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)', args: [hashes[i], String(1785326400000 + i)] });
	}
	client.close();
}
function reconcile(dbPath) {
	return execFileSync(process.execPath, [join(ROOT, 'scripts', 'reconcile-migrations.mjs'), metaDir], {
		encoding: 'utf8',
		env: { ...process.env, TURSO_DATABASE_URL: `file:${dbPath}`, TURSO_AUTH_TOKEN: '' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
}
async function appliedHashes(dbPath) {
	const client = createClient({ url: `file:${dbPath}` });
	const { rows } = await client.execute('SELECT hash FROM __drizzle_migrations ORDER BY id');
	client.close();
	return rows.map((r) => String(r.hash));
}

beforeEach(() => {});
afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('reconcile-migrations', () => {
	test('rewrites drifted hashes to the journal and leaves matched ones alone', async () => {
		const db = tempDb();
		// Simulate the license-header drift: first 16 rows have wrong hashes.
		const drifted = realHashes.map((h, i) => (i < 16 ? createHash('sha256').update(`old-content-${i}`).digest('hex') : h));
		await seededDb(db, drifted);

		const out = reconcile(db);

		expect(out).toMatch(/16 hash\(es\) updated/);
		expect(await appliedHashes(db)).toEqual(realHashes);
	});

	test('refuses to run when the applied count differs from the journal', async () => {
		const db = tempDb();
		await seededDb(db, realHashes.slice(0, 20));
		expect(() => reconcile(db)).toThrow(/REFUSING/);
	});
});
