import { afterEach, expect, test } from 'vitest';

import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

// Behavior test for migration 0021 (enforcement handle carry-through):
// moderation_actions gains the nullable author_handle column so a staged
// enforcement decision's normalized commenter handle survives until
// completeActions writes the completion audit row (I7 expand-migrate-contract:
// nullable, no default). Expand-only: no existing row may be touched.
const MIGRATION = '0021_gifted_bullseye.sql';

// The pre-0021 moderation_actions table: final 0020 shape (untouched by 0020).
const PRE_0021_DDL = `
	CREATE TABLE moderation_actions (
		comment_id TEXT PRIMARY KEY,
		channel_id TEXT NOT NULL,
		action TEXT NOT NULL,
		reason TEXT NOT NULL,
		state TEXT NOT NULL,
		last_attempt_at TEXT,
		last_manual_retry_at TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX moderation_actions_channel_state_idx ON moderation_actions (channel_id, state);
`;

const SEED = `
	INSERT INTO moderation_actions (comment_id, channel_id, action, reason, state)
	VALUES ('c1', 'UC1', 'ban', 'rule #1 (user: troll)', 'pending');
	INSERT INTO moderation_actions (comment_id, channel_id, action, reason, state, last_attempt_at)
	VALUES ('c2', 'UC1', 'reject', 'ai score 0.91', 'completed', '2026-01-04T00:00:00.000Z');
`;

afterEach(closeMigratedDbs);

test('migration 0021 adds nullable moderation_actions.author_handle and preserves every row', async () => {
	const client = await applyMigration(PRE_0021_DDL, MIGRATION, SEED);
	const cols = await client.execute('PRAGMA table_info(moderation_actions)');
	const authorHandle = cols.rows.find((row) => row.name === 'author_handle');
	expect(authorHandle, 'author_handle column').toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });

	const { rows } = await client.execute(
		'SELECT comment_id, action, state, author_handle FROM moderation_actions ORDER BY comment_id'
	);
	expect(rows).toEqual([
		{ comment_id: 'c1', action: 'ban', state: 'pending', author_handle: null },
		{ comment_id: 'c2', action: 'reject', state: 'completed', author_handle: null }
	]);
});
