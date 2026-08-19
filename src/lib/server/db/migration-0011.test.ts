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

import { createClient, type Client } from '@libsql/client';
import { expect, test } from 'vitest';

import { migrationStatements } from './migrationTestUtils';

// Behavior test for migration 0011 (account deletion v2): applied to a
// PRE-change database (users WITH the soft-delete deleted_at column and its
// index, consents WITHOUT an email column), it must drop the soft-delete
// remnants, add the nullable consents.email, backfill it from the owning
// user WITHOUT copying the tombstone sentinel, and create the partial index
// the 10-year retention sweep queries through.
const statements = migrationStatements('0011_consents_email.sql');

const PRE_0011_DDL = `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		google_sub TEXT NOT NULL UNIQUE,
		email TEXT NOT NULL,
		display_name TEXT NOT NULL,
		plan TEXT NOT NULL DEFAULT 'free',
		deleted_at TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX users_deleted_at_idx ON users (deleted_at);
	CREATE TABLE consents (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		doc_version TEXT NOT NULL,
		checkbox_text TEXT NOT NULL,
		ip TEXT NOT NULL,
		user_agent TEXT NOT NULL,
		marketing_opt_in INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
`;

async function migratedDb(seedSql: string): Promise<Client> {
	const client = createClient({ url: ':memory:' });
	await client.executeMultiple(PRE_0011_DDL + seedSql);
	for (const statement of statements) await client.execute(statement);
	return client;
}

test('migration 0011 drops the soft-delete column and its index', async () => {
	const client = await migratedDb('');
	const userCols = await client.execute('PRAGMA table_info(users)');
	expect(userCols.rows.map((row) => row.name)).not.toContain('deleted_at');
	const userIdx = await client.execute('PRAGMA index_list(users)');
	expect(userIdx.rows.map((row) => row.name)).not.toContain('users_deleted_at_idx');
});

test('migration 0011 adds the email column and backfills it from the owning user', async () => {
	const client = await migratedDb(`
		INSERT INTO users (id, google_sub, email, display_name)
		VALUES ('user-1', 'sub-1', 'one@example.com', 'One');
		INSERT INTO consents (user_id, doc_version, checkbox_text, ip, user_agent)
		VALUES ('user-1', 'v1.2', 'I agree', '127.0.0.1', 'test');
	`);
	const { rows } = await client.execute('SELECT * FROM consents');
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		user_id: 'user-1',
		email: 'one@example.com',
		doc_version: 'v1.2',
		checkbox_text: 'I agree'
	});
});

test('migration 0011 does not backfill the tombstone sentinel from pre-migration deletions', async () => {
	// PR #42 review: a user deleted BEFORE this migration has users.email =
	// '[deleted]' (the tombstone sentinel, kept NOT NULL). The backfill must
	// leave that consent row's email NULL — the sentinel is not evidence.
	const client = await migratedDb(`
		INSERT INTO users (id, google_sub, email, display_name)
		VALUES ('gone', 'deleted:gone', '[deleted]', '[deleted]');
		INSERT INTO consents (user_id, doc_version, checkbox_text, ip, user_agent)
		VALUES ('gone', 'v1.2', 'I agree', '127.0.0.1', 'test');
	`);
	const { rows } = await client.execute('SELECT * FROM consents');
	expect(rows).toHaveLength(1);
	expect(rows[0].email).toBeNull();
});

test('the retention sweep query uses the new partial index, not a table scan', async () => {
	// sqlite-engineering rule: every new WHERE shape ships with EXPLAIN QUERY
	// PLAN evidence. The sweep is WHERE email IS NOT NULL AND created_at < ?
	// LIMIT 50 — a SCAN here would read the whole table on every cron tick.
	const client = await migratedDb(`
		INSERT INTO users (id, google_sub, email, display_name)
		VALUES ('user-1', 'sub-1', 'one@example.com', 'One');
		INSERT INTO consents (user_id, doc_version, checkbox_text, ip, user_agent)
		VALUES ('user-1', 'v1.2', 'I agree', '127.0.0.1', 'test');
	`);
	const idx = await client.execute('PRAGMA index_list(consents)');
	expect(idx.rows.map((row) => row.name)).toContain('consents_email_retention_idx');
	const plan = await client.execute({
		sql: 'EXPLAIN QUERY PLAN SELECT id FROM consents WHERE email IS NOT NULL AND created_at < ? LIMIT 50',
		args: ['2016-01-01T00:00:00Z']
	});
	expect(plan.rows.map((row) => row.detail).join(' | ')).toContain('SEARCH consents USING INDEX consents_email_retention_idx');
});
