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

import { readFileSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { expect, test } from 'vitest';

// Behavior test for migration 0013 (tenancy contract): applied to a
// PRE-contract database (channels has org_id but no CHECK), it rebuilds the
// table with channels_org_requires_owner — a channel may lack an org ONLY
// while it also lacks an owner (pre-accounts orphans awaiting first-login
// claim). All rows, columns, and indexes must survive the rebuild, and the
// constraint must bite on INSERT and UPDATE alike.
const migration = readFileSync(new URL('../../../../drizzle/0013_channels_org_contract.sql', import.meta.url), 'utf8');
const statements = migration
	.split('--> statement-breakpoint')
	.map((chunk) =>
		chunk
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('--'))
			.join('\n')
			.trim()
	)
	.filter((chunk) => chunk.length > 0);

// The pre-contract channels table: final 0012 shape (org_id present, no CHECK).
const PRE_0013_DDL = `
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
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX channels_user_id_idx ON channels (user_id);
	CREATE INDEX channels_org_id_idx ON channels (org_id);
`;

// One owned+orged channel, one unclaimed orphan — both legal under the contract.
const SEED = `
	INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc)
	VALUES ('UCowned', 'user-1', 'org-1', 'Owned', 'enc-a');
	INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc)
	VALUES ('UCorphan', NULL, NULL, 'Orphan', 'enc-o');
`;

async function migratedDb(seedSql: string): Promise<Client> {
	const client = createClient({ url: ':memory:' });
	await client.execute('PRAGMA foreign_keys = ON');
	await client.executeMultiple(PRE_0013_DDL + seedSql);
	for (const statement of statements) await client.execute(statement);
	return client;
}

test('migration 0013 adds the contract and preserves rows, columns, and indexes', async () => {
	const client = await migratedDb(SEED);
	const ddl = await client.execute("SELECT sql FROM sqlite_master WHERE name = 'channels' AND type = 'table'");
	expect(ddl.rows[0].sql).toContain('channels_org_requires_owner');
	const { rows } = await client.execute('SELECT id, user_id, org_id FROM channels ORDER BY id');
	expect(rows).toEqual([
		{ id: 'UCorphan', user_id: null, org_id: null },
		{ id: 'UCowned', user_id: 'user-1', org_id: 'org-1' }
	]);
	const cols = await client.execute('PRAGMA table_info(channels)');
	expect(cols.rows).toHaveLength(13);
	const idx = await client.execute('PRAGMA index_list(channels)');
	expect(idx.rows.map((row) => row.name)).toEqual(expect.arrayContaining(['channels_user_id_idx', 'channels_org_id_idx']));
});

test('the contract rejects an owned channel with no org, on INSERT and UPDATE', async () => {
	const client = await migratedDb(SEED);
	await expect(
		client.execute("INSERT INTO channels (id, user_id, title, refresh_token_enc) VALUES ('UCbad', 'user-1', 'Bad', 'enc-b')")
	).rejects.toThrow(/channels_org_requires_owner/);
	await expect(client.execute("UPDATE channels SET org_id = NULL WHERE id = 'UCowned'")).rejects.toThrow(
		/channels_org_requires_owner/
	);
	// Nothing slipped through: the rejected INSERT wrote no row, the rejected
	// UPDATE left the owned row orged.
	const { rows } = await client.execute("SELECT id, org_id FROM channels WHERE id IN ('UCbad', 'UCowned')");
	expect(rows).toEqual([{ id: 'UCowned', org_id: 'org-1' }]);
});

test('the contract still allows unclaimed orphans and fully-owned channels', async () => {
	const client = await migratedDb('');
	await client.execute("INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc) VALUES ('UCo', NULL, NULL, 'o', 'x')");
	await client.execute(
		"INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc) VALUES ('UCf', 'user-1', 'org-1', 'f', 'x')"
	);
	const { rows } = await client.execute('SELECT count(*) AS c FROM channels');
	expect(rows[0].c).toBe(2);
});
