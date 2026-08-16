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

import { afterEach, expect, test } from 'vitest';

import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

// Behavior test for migration 0020 (protected-handles allowlist): the new
// channel_allowed_handles table holds the per-channel allowlist of
// normalized commenter handles, and audit_log gains the nullable
// author_handle column (I7 expand-migrate-contract: nullable, no default).
// Expand-only: no existing row may be touched.
const MIGRATION = '0020_harsh_lila_cheney.sql';

// The pre-0020 audit_log table: final 0019 shape (text column, composite index).
const PRE_0020_DDL = `
	CREATE TABLE audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		channel_id TEXT NOT NULL,
		comment_id TEXT NOT NULL,
		action TEXT NOT NULL,
		reason TEXT NOT NULL,
		actor TEXT NOT NULL,
		text TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX audit_log_channel_action_idx ON audit_log (channel_id, action);
`;

const SEED = `
	INSERT INTO audit_log (channel_id, comment_id, action, reason, actor, text)
	VALUES ('UC1', 'c1', 'dry-run', 'rule #1 (keyword)', 'system', 'buy my stuff');
	INSERT INTO audit_log (channel_id, comment_id, action, reason, actor)
	VALUES ('UC1', 'c2', 'approve', 'manual', 'user');
`;

afterEach(closeMigratedDbs);

test('migration 0020 creates channel_allowed_handles with its channel index', async () => {
	const client = await applyMigration(PRE_0020_DDL, MIGRATION);
	const cols = await client.execute('PRAGMA table_info(channel_allowed_handles)');
	expect(cols.rows.map((row) => [row.name, row.type, row.notnull, row.pk])).toEqual([
		['id', 'INTEGER', 1, 1],
		['channel_id', 'TEXT', 1, 0],
		['handle', 'TEXT', 1, 0],
		['created_at', 'TEXT', 1, 0]
	]);
	const idx = await client.execute('PRAGMA index_list(channel_allowed_handles)');
	expect(idx.rows.map((row) => row.name)).toContain('channel_allowed_handles_channel_idx');
	const idxCols = await client.execute('PRAGMA index_info(channel_allowed_handles_channel_idx)');
	expect(idxCols.rows.map((row) => row.name)).toEqual(['channel_id']);

	// The table is writable and created_at defaults like the neighboring tables.
	await client.execute("INSERT INTO channel_allowed_handles (channel_id, handle) VALUES ('UC1', '@friend')");
	const inserted = await client.execute('SELECT channel_id, handle, created_at FROM channel_allowed_handles');
	expect(inserted.rows).toEqual([
		{ channel_id: 'UC1', handle: '@friend', created_at: expect.any(String) }
	]);
});

test('migration 0020 adds nullable audit_log.author_handle and preserves every row', async () => {
	const client = await applyMigration(PRE_0020_DDL, MIGRATION, SEED);
	const cols = await client.execute('PRAGMA table_info(audit_log)');
	const authorHandle = cols.rows.find((row) => row.name === 'author_handle');
	expect(authorHandle, 'author_handle column').toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });

	const { rows } = await client.execute(
		'SELECT comment_id, action, actor, text, author_handle FROM audit_log ORDER BY comment_id'
	);
	expect(rows).toEqual([
		{ comment_id: 'c1', action: 'dry-run', actor: 'system', text: 'buy my stuff', author_handle: null },
		{ comment_id: 'c2', action: 'approve', actor: 'user', text: null, author_handle: null }
	]);
});
