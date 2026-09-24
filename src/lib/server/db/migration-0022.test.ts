import { afterEach, expect, test } from 'vitest';

import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

// Behavior test for migration 0022 (log-page index, qodo review on PR #125):
// audit_log gains a (channel_id, comment_id) composite index so the log page's
// latest-per-comment query (channel_id = ? AND comment_id IN (...)) does not
// scan every audit row of the channel. Expand-only: no existing row may be
// touched, and the pre-existing (channel_id, action) index must survive.
const MIGRATION = '0022_audit_log_channel_comment_idx.sql';

// The pre-0022 audit_log table: final 0021 shape (untouched by 0021).
const PRE_0022_DDL = `
	CREATE TABLE audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		channel_id TEXT NOT NULL,
		comment_id TEXT NOT NULL,
		action TEXT NOT NULL,
		reason TEXT NOT NULL,
		actor TEXT NOT NULL,
		text TEXT,
		author_handle TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX audit_log_channel_action_idx ON audit_log (channel_id, action);
`;

const SEED = `
	INSERT INTO audit_log (channel_id, comment_id, action, reason, actor)
	VALUES ('UC1', 'c1', 'hold', 'rule #1', 'system');
	INSERT INTO audit_log (channel_id, comment_id, action, reason, actor)
	VALUES ('UC1', 'c2', 'approve', 'ai score 0.91', 'system');
	INSERT INTO audit_log (channel_id, comment_id, action, reason, actor)
	VALUES ('UC2', 'c1', 'ban', 'rule #2', 'system');
`;

afterEach(closeMigratedDbs);

test('migration 0022 adds the (channel_id, comment_id) index and preserves every row', async () => {
	const client = await applyMigration(PRE_0022_DDL, MIGRATION, SEED);

	const indexes = await client.execute("PRAGMA index_list('audit_log')");
	const names = indexes.rows.map((row) => String(row.name));
	expect(names).toContain('audit_log_channel_action_idx');
	expect(names).toContain('audit_log_channel_comment_idx');

	const columns = await client.execute("PRAGMA index_info('audit_log_channel_comment_idx')");
	// Columns are reported in creation order, seqno 0 then 1.
	expect(columns.rows.map((row) => String(row.name))).toEqual(['channel_id', 'comment_id']);

	const { rows } = await client.execute(
		'SELECT channel_id, comment_id, action FROM audit_log ORDER BY id'
	);
	expect(rows).toEqual([
		{ channel_id: 'UC1', comment_id: 'c1', action: 'hold' },
		{ channel_id: 'UC1', comment_id: 'c2', action: 'approve' },
		{ channel_id: 'UC2', comment_id: 'c1', action: 'ban' }
	]);
});
