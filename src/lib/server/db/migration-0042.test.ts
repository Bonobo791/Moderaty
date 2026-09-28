import { afterEach, expect, test } from 'vitest';

import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

const MIGRATION = '0042_feedback_history.sql';

const PRE_0042_DDL = `
	CREATE TABLE channels (
		id TEXT PRIMARY KEY,
		active INTEGER NOT NULL DEFAULT 1,
		dry_run_boundary TEXT
	);
	CREATE TABLE audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		channel_id TEXT NOT NULL,
		action TEXT NOT NULL,
		created_at TEXT NOT NULL
	);
`;

const SEED = `
	INSERT INTO channels (id, active, dry_run_boundary) VALUES ('UCdrain', 1, '2026-05-01T00:00:00.000Z');
	INSERT INTO channels (id, active, dry_run_boundary) VALUES ('UCpreview', 1, NULL);
	INSERT INTO channels (id, active, dry_run_boundary) VALUES ('UCuntouched', 1, NULL);
	INSERT INTO audit_log (channel_id, action, created_at) VALUES ('UCpreview', 'dry-run', '2026-01-05T00:00:00.000Z');
	INSERT INTO audit_log (channel_id, action, created_at) VALUES ('UCpreview', 'dry-run', '2026-01-02T00:00:00.000Z');
`;

afterEach(closeMigratedDbs);

test('0042 adds nullable allowance and feedback-history checkpoint columns', async () => {
	const client = await applyMigration(PRE_0042_DDL, MIGRATION, SEED);
	const info = await client.execute('PRAGMA table_info(channels)');
	const names = info.rows.map((row) => String(row.name));
	const columns = ['moderation_dry_run_used_at', 'feedback_dry_run_used_at', 'feedback_history_boundary', 'feedback_history_page_token'];
	for (const name of columns) {
		expect(names).toContain(name);
		expect(info.rows.find((row) => row.name === name)?.notnull, `${name} must be nullable`).toBe(0);
	}
	const rows = await client.execute(
		`SELECT id, moderation_dry_run_used_at, feedback_dry_run_used_at, feedback_history_boundary, feedback_history_page_token FROM channels ORDER BY id`
	);
	// Only a persisted dry_run_boundary is unambiguous dashboard-preview usage:
	// audit 'dry-run' rows are also written by every run on a deployment with
	// DRY_RUN=true, so backfilling from them would steal the preview allowance
	// from channels that never used it (codex). A completed preview's boundary
	// is already gone — those channels get their allowance fresh, which is
	// harmless: the allowance did not exist before this migration.
	expect(rows.rows).toEqual([
		{ id: 'UCdrain', moderation_dry_run_used_at: '2026-05-01T00:00:00.000Z', feedback_dry_run_used_at: null, feedback_history_boundary: null, feedback_history_page_token: null },
		{ id: 'UCpreview', moderation_dry_run_used_at: null, feedback_dry_run_used_at: null, feedback_history_boundary: null, feedback_history_page_token: null },
		{ id: 'UCuntouched', moderation_dry_run_used_at: null, feedback_dry_run_used_at: null, feedback_history_boundary: null, feedback_history_page_token: null }
	]);
});

test('0042 creates a unique history-source table with no author identity columns', async () => {
	const client = await applyMigration(PRE_0042_DDL, MIGRATION, SEED);
	const info = await client.execute('PRAGMA table_info(feedback_history_comments)');
	expect(info.rows.map((row) => String(row.name))).toEqual(['id', 'channel_id', 'text', 'published_at']);
	expect(info.rows.some((row) => /author|handle|avatar/i.test(String(row.name)))).toBe(false);
	await client.execute("INSERT INTO feedback_history_comments (id, channel_id, text, published_at) VALUES ('c1', 'UCdrain', 'a comment', '2026-01-01T00:00:00Z')");
	await expect(
		client.execute("INSERT INTO feedback_history_comments (id, channel_id, text, published_at) VALUES ('c1', 'UCdrain', 'duplicate', '2026-01-02T00:00:00Z')")
	).rejects.toThrow();
	const indexes = await client.execute('PRAGMA index_list(feedback_history_comments)');
	expect(indexes.rows.map((row) => row.name)).toContain('feedback_history_comments_channel_idx');
});
