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

// Behavior test for migration 0012 (multi-tenancy expand + backfill): applied
// to a PRE-tenancy database (users/sessions/channels only — no org tables, no
// sessions.active_org_id, no channels.org_id), it must create the three
// tenant tables, add both columns, and backfill exactly one personal org +
// owner membership per surviving user (plan copied from users.plan), point
// every owned channel at its owner's personal org, leave unclaimed orphans
// org-less, give tombstoned users nothing, and be idempotent on re-run.
const statements = migrationStatements('0012_organizations.sql');

// The three hand-appended backfill statements, for the idempotency re-run.
const backfill = statements.filter(
	(s) =>
		s.startsWith('INSERT INTO organizations') ||
		s.startsWith('INSERT INTO memberships') ||
		s.startsWith('UPDATE channels')
);
if (backfill.length !== 3) throw new Error(`expected 3 backfill statements in 0012, found ${backfill.length}`);

const PRE_0012_DDL = `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		google_sub TEXT NOT NULL UNIQUE,
		email TEXT NOT NULL,
		display_name TEXT NOT NULL,
		plan TEXT NOT NULL DEFAULT 'free',
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE TABLE channels (
		id TEXT PRIMARY KEY,
		user_id TEXT,
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
`;

// Two surviving users (one on a paid plan), one tombstoned user, two owned
// channels, one unclaimed orphan channel.
const SEED = `
	INSERT INTO users (id, google_sub, email, display_name, plan)
	VALUES ('user-1', 'sub-1', 'one@example.com', 'One', 'pro');
	INSERT INTO users (id, google_sub, email, display_name, plan)
	VALUES ('user-2', 'sub-2', 'two@example.com', 'Two', 'free');
	INSERT INTO users (id, google_sub, email, display_name)
	VALUES ('gone', 'deleted:gone', '[deleted]', '[deleted]');
	INSERT INTO channels (id, user_id, title, refresh_token_enc)
	VALUES ('UCa', 'user-1', 'Channel A', 'enc-a');
	INSERT INTO channels (id, user_id, title, refresh_token_enc)
	VALUES ('UCb', 'user-2', 'Channel B', 'enc-b');
	INSERT INTO channels (id, user_id, title, refresh_token_enc)
	VALUES ('UCorphan', NULL, 'Orphan', 'enc-o');
`;

async function migratedDb(seedSql: string): Promise<Client> {
	const client = createClient({ url: ':memory:' });
	await client.execute('PRAGMA foreign_keys = ON');
	await client.executeMultiple(PRE_0012_DDL + seedSql);
	for (const statement of statements) await client.execute(statement);
	return client;
}

test('migration 0012 creates the tenant tables and expand columns', async () => {
	const client = await migratedDb('');
	const tables = await client.execute(
		"SELECT name FROM sqlite_master WHERE name IN ('organizations','memberships','invites') ORDER BY name"
	);
	expect(tables.rows.map((row) => row.name)).toEqual(['invites', 'memberships', 'organizations']);
	const sessionCols = await client.execute('PRAGMA table_info(sessions)');
	expect(sessionCols.rows.map((row) => row.name)).toContain('active_org_id');
	const channelCols = await client.execute('PRAGMA table_info(channels)');
	expect(channelCols.rows.map((row) => row.name)).toContain('org_id');
	const orgIdx = await client.execute('PRAGMA index_list(organizations)');
	expect(orgIdx.rows.map((row) => row.name)).toContain('organizations_personal_for_unique');
	const chIdx = await client.execute('PRAGMA index_list(channels)');
	expect(chIdx.rows.map((row) => row.name)).toContain('channels_org_id_idx');
});

test('backfill gives every surviving user exactly one personal org with plan and name copied', async () => {
	const client = await migratedDb(SEED);
	const { rows } = await client.execute('SELECT * FROM organizations WHERE personal_for IS NOT NULL');
	expect(rows).toHaveLength(2);
	const byUser = Object.fromEntries(rows.map((row) => [row.personal_for, row]));
	expect(byUser['user-1']).toMatchObject({ name: 'One', plan: 'pro' });
	expect(byUser['user-2']).toMatchObject({ name: 'Two', plan: 'free' });
});

test('backfill gives every surviving user an owner membership in their personal org', async () => {
	const client = await migratedDb(SEED);
	const { rows } = await client.execute(
		`SELECT m.user_id, m.role, m.org_id = o.id AS in_personal_org
		 FROM memberships m JOIN organizations o ON o.personal_for = m.user_id`
	);
	expect(rows).toHaveLength(2);
	for (const row of rows) {
		expect(row.role).toBe('owner');
		expect(row.in_personal_org).toBe(1);
	}
});

test('backfill gives tombstoned users no org and no membership', async () => {
	const client = await migratedDb(SEED);
	const orgs = await client.execute({
		sql: "SELECT COUNT(*) AS c FROM organizations WHERE personal_for IN (SELECT id FROM users WHERE google_sub LIKE 'deleted:%')",
		args: []
	});
	expect(orgs.rows[0].c).toBe(0);
	const mems = await client.execute({
		sql: "SELECT COUNT(*) AS c FROM memberships WHERE user_id IN (SELECT id FROM users WHERE google_sub LIKE 'deleted:%')",
		args: []
	});
	expect(mems.rows[0].c).toBe(0);
});

test('backfill points every owned channel at its owner personal org and leaves orphans org-less', async () => {
	const client = await migratedDb(SEED);
	const { rows } = await client.execute(
		`SELECT c.id, c.org_id, o.personal_for FROM channels c
		 LEFT JOIN organizations o ON o.id = c.org_id ORDER BY c.id`
	);
	const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
	expect(byId.UCa.personal_for).toBe('user-1');
	expect(byId.UCb.personal_for).toBe('user-2');
	expect(byId.UCorphan.org_id).toBeNull();
	const ownedMissing = await client.execute(
		'SELECT COUNT(*) AS c FROM channels WHERE user_id IS NOT NULL AND org_id IS NULL'
	);
	expect(ownedMissing.rows[0].c).toBe(0);
});

test('re-running the backfill statements changes zero rows (idempotency)', async () => {
	const client = await migratedDb(SEED);
	const snapshot = async () =>
		JSON.stringify([
			(await client.execute('SELECT * FROM organizations ORDER BY id')).rows,
			(await client.execute('SELECT * FROM memberships ORDER BY user_id, org_id')).rows,
			(await client.execute('SELECT id, org_id FROM channels ORDER BY id')).rows
		]);
	const before = await snapshot();
	for (const statement of backfill) await client.execute(statement);
	expect(await snapshot()).toBe(before);
});

test('re-running the backfill repairs a missing owner membership for a user in a shared org', async () => {
	// PR #48 review (CodeRabbit/Qodo): the membership guard must skip only when
	// the user is already a member of THEIR personal org — not when they hold
	// any membership anywhere (shared orgs exist from Phase D on; a manual
	// backfill re-run after that must still self-repair).
	const client = await migratedDb(SEED);
	await client.execute("INSERT INTO organizations (id, name) VALUES ('shared', 'Shared')");
	await client.execute("INSERT INTO memberships (user_id, org_id, role) VALUES ('user-1', 'shared', 'member')");
	await client.execute("DELETE FROM memberships WHERE user_id = 'user-1' AND org_id <> 'shared'");
	for (const statement of backfill) await client.execute(statement);
	const { rows } = await client.execute(
		`SELECT m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
		 WHERE m.user_id = 'user-1' AND o.personal_for = 'user-1'`
	);
	expect(rows).toHaveLength(1);
	expect(rows[0].role).toBe('owner');
});

test('tenant-scoped channel lookups use the new org index, not a table scan', async () => {
	// sqlite-engineering rule: every new WHERE shape ships with EXPLAIN QUERY
	// PLAN evidence. ownedChannel and the dashboard list filter by org_id — a
	// SCAN here would read every tenant's channels on every request.
	const client = await migratedDb(SEED);
	const plan = await client.execute({
		sql: 'EXPLAIN QUERY PLAN SELECT id FROM channels WHERE org_id = ?',
		args: ['x']
	});
	expect(plan.rows.map((row) => row.detail).join(' | ')).toContain(
		'SEARCH channels USING INDEX channels_org_id_idx'
	);
});
