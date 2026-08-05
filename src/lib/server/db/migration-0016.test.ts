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

// Behavior test for migration 0016 (issue #77): audit_log gains a composite
// (channel_id, action) index. The dashboard ban counter filters
// action='ban' + channel_id IN (...) GROUP BY channel_id; the per-channel
// log page filters channel_id alone. Expand-only (I7): creating an index
// must not touch a single row.
const MIGRATION = '0016_audit_log_channel_action_idx.sql';

// The pre-0016 audit_log table: shape since 0000, no secondary indexes.
const PRE_0016_DDL = `
	CREATE TABLE audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		channel_id TEXT NOT NULL,
		comment_id TEXT NOT NULL,
		action TEXT NOT NULL,
		reason TEXT NOT NULL,
		actor TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
`;

// Ban rows are rare and concentrated on two channels; the bulk is other
// actions spread across ten other channels, so the planner cannot cheaply
// answer either query with a full scan.
const SEED = `
	WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000)
	INSERT INTO audit_log (channel_id, comment_id, action, reason, actor)
	SELECT 'UCbulk' || (x % 10), 'c' || x, CASE x % 3 WHEN 0 THEN 'hold' WHEN 1 THEN 'approve' ELSE 'queue' END, 'r', 'system' FROM c;
	INSERT INTO audit_log (channel_id, comment_id, action, reason, actor) VALUES
		('UCa', 'cb1', 'ban', 'r', 'user'),
		('UCa', 'cb2', 'ban', 'r', 'user'),
		('UCa', 'ch1', 'hold', 'r', 'system'),
		('UCb', 'cb3', 'ban', 'r', 'user'),
		('UCb', 'ch2', 'hold', 'r', 'system');
`;

afterEach(closeMigratedDbs);

test('migration 0016 adds the composite index and preserves every row', async () => {
	const client = await applyMigration(PRE_0016_DDL, MIGRATION, SEED);
	const idx = await client.execute("PRAGMA index_list('audit_log')");
	expect(idx.rows.map((row) => row.name)).toContain('audit_log_channel_action_idx');
	const cols = await client.execute("PRAGMA index_info('audit_log_channel_action_idx')");
	expect(cols.rows.map((row) => row.name)).toEqual(['channel_id', 'action']);
	const { rows } = await client.execute(
		"SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY action"
	);
	expect(rows).toEqual([
		{ action: 'approve', n: 334 },
		{ action: 'ban', n: 3 },
		{ action: 'hold', n: 335 },
		{ action: 'queue', n: 333 }
	]);
});

test('the ban-count and channel-log queries use the index', async () => {
	const client = await applyMigration(PRE_0016_DDL, MIGRATION, SEED);
	const banPlan = await client.execute(
		"EXPLAIN QUERY PLAN SELECT channel_id, COUNT(*) FROM audit_log WHERE action = 'ban' AND channel_id IN ('UCa', 'UCb') GROUP BY channel_id"
	);
	expect(banPlan.rows.map((row) => row.detail).join('\n')).toContain('audit_log_channel_action_idx');
	const logPlan = await client.execute(
		"EXPLAIN QUERY PLAN SELECT id FROM audit_log WHERE channel_id = 'UCa' ORDER BY created_at DESC, id DESC LIMIT 50"
	);
	expect(logPlan.rows.map((row) => row.detail).join('\n')).toContain('audit_log_channel_action_idx');
});
