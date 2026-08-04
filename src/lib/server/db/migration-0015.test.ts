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
import { afterEach, expect, test } from 'vitest';

import { migrationStatements } from './migrationTestUtils';

// Behavior test for migration 0015: per-channel protection settings.
// channels gains protect_lgbtqia and protect_women — off-by-default (0)
// toggles, same convention as marketing_opt_in (integer NOT NULL DEFAULT 0).
// Expand-only per I7: existing rows must read 0 without any backfill, new
// inserts default to 0, explicit 1 is writable, and the tenancy contract is
// untouched.
const statements = migrationStatements('0015_channels_protect_flags.sql');

// The pre-0015 channels table: final 0014 shape (tenancy contract + history
// drain state, 15 columns).
const PRE_0015_DDL = `
	CREATE TABLE channels (
		id TEXT PRIMARY KEY,
		user_id TEXT,
		org_id TEXT,
		title TEXT NOT NULL,
		refresh_token_enc TEXT NOT NULL,
		cursor TEXT,
		next_page_token TEXT,
		scan_cursor TEXT,
		history_next_page_token TEXT,
		history_boundary TEXT,
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

const SEED = `
	INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc)
	VALUES ('UCexisting', 'user-1', 'org-1', 'Existing', 'enc-e');
`;

async function migratedDb(seedSql: string): Promise<Client> {
	const client = createClient({ url: ':memory:' });
	openClients.push(client);
	await client.execute('PRAGMA foreign_keys = ON');
	await client.executeMultiple(PRE_0015_DDL + seedSql);
	for (const statement of statements) await client.execute(statement);
	return client;
}

// Every client a test opens is closed, even when an assertion fails mid-test.
const openClients: Client[] = [];
afterEach(() => {
	for (const client of openClients.splice(0)) client.close();
});

test('migration 0015 adds both protection flags and existing rows read 0', async () => {
	const client = await migratedDb(SEED);
	const cols = await client.execute('PRAGMA table_info(channels)');
	const names = cols.rows.map((row) => row.name);
	expect(names).toContain('protect_lgbtqia');
	expect(names).toContain('protect_women');
	expect(cols.rows).toHaveLength(17);
	for (const flag of ['protect_lgbtqia', 'protect_women']) {
		const col = cols.rows.find((row) => row.name === flag);
		expect(col?.notnull, `${flag} must be NOT NULL`).toBe(1);
		expect(col?.dflt_value, `${flag} must default 0`).toBe('0');
	}
	const { rows } = await client.execute('SELECT id, protect_lgbtqia, protect_women FROM channels');
	expect(rows).toEqual([{ id: 'UCexisting', protect_lgbtqia: 0, protect_women: 0 }]);
});

test('new inserts default both flags to 0 and accept explicit opt-in', async () => {
	const client = await migratedDb('');
	await client.execute(
		"INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc) VALUES ('UCdefault', 'user-1', 'org-1', 'D', 'enc')"
	);
	await client.execute(
		"INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc, protect_lgbtqia, protect_women) VALUES ('UCon', 'user-1', 'org-1', 'On', 'enc', 1, 1)"
	);
	const { rows } = await client.execute('SELECT id, protect_lgbtqia, protect_women FROM channels ORDER BY id');
	expect(rows).toEqual([
		{ id: 'UCdefault', protect_lgbtqia: 0, protect_women: 0 },
		{ id: 'UCon', protect_lgbtqia: 1, protect_women: 1 }
	]);
});

test('the tenancy contract still bites after 0015', async () => {
	const client = await migratedDb(SEED);
	await expect(
		client.execute("INSERT INTO channels (id, user_id, title, refresh_token_enc) VALUES ('UCbad', 'user-1', 'Bad', 'enc-b')")
	).rejects.toThrow(/channels_org_requires_owner/);
});
