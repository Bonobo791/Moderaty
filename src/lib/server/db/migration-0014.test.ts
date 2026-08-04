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

import { createClient, type Client } from '@libsql/client';
import { expect, test } from 'vitest';

import { migrationStatements } from './migrationTestUtils';

// Behavior test for migration 0014 (issue #70: live-first scanning during
// long history drains). Expand-only (I7): two nullable columns on channels
// carry the drain state — history_next_page_token (drain continuation) and
// history_boundary (ISO timestamp the drain started walking back from) — so
// the live cursor keeps advancing on newest comments every run while the
// drain walks history independently. A drain in flight at deploy time must
// have its continuation state BACKFILLED into the new columns so it keeps
// walking from where it was; the old columns stay untouched (the backend
// switches reads over separately).
const statements = migrationStatements('0014_channels_history_state.sql');

// The pre-0014 channels table: final 0013 shape (tenancy contract live).
const PRE_0014_DDL = `
	CREATE TABLE channels (
		id TEXT PRIMARY KEY,
		user_id TEXT,
		org_id TEXT,
		title TEXT NOT NULL,
		refresh_token_enc TEXT NOT NULL,
		cursor TEXT,
		next_page_token TEXT,
		scan_cursor TEXT,
		last_run_at TEXT,
		lease_expires_at TEXT,
		active INTEGER NOT NULL DEFAULT 1,
		tone_level INTEGER,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		CONSTRAINT channels_org_requires_owner CHECK(org_id IS NOT NULL OR user_id IS NULL)
	);
	CREATE INDEX channels_user_id_idx ON channels (user_id);
	CREATE INDEX channels_org_id_idx ON channels (org_id);
`;

// UCdrain is mid-drain (continuation token + pending high-water set); UClive
// is live-only (both NULL — nothing to backfill). Every other column carries
// a distinct value so row preservation is checked exactly.
const SEED = `
	INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc, cursor, next_page_token, scan_cursor, last_run_at, lease_expires_at, active, tone_level, created_at)
	VALUES ('UCdrain', 'user-1', 'org-1', 'Draining', 'enc-d', 'cur-d', 'page-deep', '2026-07-01T00:00:00.000Z', 'run-d', 'lease-d', 1, 2, '2026-01-01T00:00:00.000Z');
	INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc, cursor, next_page_token, scan_cursor, last_run_at, lease_expires_at, active, tone_level, created_at)
	VALUES ('UClive', 'user-1', 'org-1', 'LiveOnly', 'enc-l', 'cur-l', NULL, NULL, 'run-l', NULL, 0, NULL, '2026-01-02T00:00:00.000Z');
`;

async function migratedDb(seedSql: string): Promise<Client> {
	const client = createClient({ url: ':memory:' });
	await client.execute('PRAGMA foreign_keys = ON');
	await client.executeMultiple(PRE_0014_DDL + seedSql);
	for (const statement of statements) await client.execute(statement);
	return client;
}

test('migration 0014 adds the history columns and preserves every row', async () => {
	const client = await migratedDb(SEED);
	const cols = await client.execute('PRAGMA table_info(channels)');
	expect(cols.rows.map((row) => row.name)).toEqual([
		'id',
		'user_id',
		'org_id',
		'title',
		'refresh_token_enc',
		'cursor',
		'next_page_token',
		'scan_cursor',
		'last_run_at',
		'lease_expires_at',
		'active',
		'tone_level',
		'created_at',
		'history_next_page_token',
		'history_boundary'
	]);
	const { rows } = await client.execute(
		'SELECT id, title, cursor, next_page_token, scan_cursor, active, tone_level, created_at FROM channels ORDER BY id'
	);
	expect(rows).toEqual([
		{
			id: 'UCdrain',
			title: 'Draining',
			cursor: 'cur-d',
			next_page_token: 'page-deep',
			scan_cursor: '2026-07-01T00:00:00.000Z',
			active: 1,
			tone_level: 2,
			created_at: '2026-01-01T00:00:00.000Z'
		},
		{
			id: 'UClive',
			title: 'LiveOnly',
			cursor: 'cur-l',
			next_page_token: null,
			scan_cursor: null,
			active: 0,
			tone_level: null,
			created_at: '2026-01-02T00:00:00.000Z'
		}
	]);
});

test('an in-flight drain is backfilled; live-only channels stay NULL; old columns untouched', async () => {
	const client = await migratedDb(SEED);
	const { rows } = await client.execute(
		'SELECT id, next_page_token, scan_cursor, history_next_page_token, history_boundary FROM channels ORDER BY id'
	);
	expect(rows).toEqual([
		{
			id: 'UCdrain',
			next_page_token: 'page-deep', // old columns preserved until the backend switches over
			scan_cursor: '2026-07-01T00:00:00.000Z',
			history_next_page_token: 'page-deep',
			history_boundary: '2026-07-01T00:00:00.000Z'
		},
		{
			id: 'UClive',
			next_page_token: null,
			scan_cursor: null,
			history_next_page_token: null,
			history_boundary: null
		}
	]);
});

test('the tenancy contract still bites after 0014', async () => {
	const client = await migratedDb(SEED);
	await expect(
		client.execute("INSERT INTO channels (id, user_id, title, refresh_token_enc) VALUES ('UCbad', 'user-1', 'Bad', 'enc-b')")
	).rejects.toThrow(/channels_org_requires_owner/);
	// And the new columns accept writes on both legal shapes.
	await client.execute(
		"INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc, history_boundary) VALUES ('UCnew', 'user-1', 'org-1', 'New', 'enc-n', '2026-08-01T00:00:00.000Z')"
	);
	const { rows } = await client.execute("SELECT history_boundary FROM channels WHERE id = 'UCnew'");
	expect(rows[0].history_boundary).toBe('2026-08-01T00:00:00.000Z');
});
