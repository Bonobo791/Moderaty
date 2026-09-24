import { afterEach, expect, test } from 'vitest';

import { applyMigration, closeMigratedDbs, expectTenancyContract } from './migrationTestUtils';

// Behavior test for migration 0039: the feedback-digest tables (P-MOD-5)
// plus the six nullable feedback_* columns on channels. Expand-only per I7:
// existing channel rows must read NULL (feature off / defaults apply), the
// digest chain must cascade digest → findings → evidence, the
// (channel_id, window_start, window_end) unique index is the idempotency
// anchor, and no table may carry an author column.
const MIGRATION = '0039_feedback_digest.sql';

// The pre-0039 channels table: final 0038 shape (tenancy contract, dry-run
// drain state, run-health columns — 22 columns).
const PRE_0039_DDL = `
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
		dry_run_boundary TEXT,
		dry_run_page_token TEXT,
		last_run_at TEXT,
		last_run_status TEXT,
		last_success_at TEXT,
		last_run_error TEXT,
		lease_expires_at TEXT,
		active INTEGER NOT NULL DEFAULT 1,
		tone_level INTEGER,
		protect_lgbtqia INTEGER NOT NULL DEFAULT 0,
		protect_women INTEGER NOT NULL DEFAULT 0,
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

const FEEDBACK_COLUMNS = [
	'feedback_enabled',
	'feedback_cadence',
	'feedback_categories',
	'feedback_threshold',
	'feedback_email',
	'feedback_last_digest_at'
];

afterEach(closeMigratedDbs);

test('0039 adds the six feedback controls nullable; existing rows read NULL (feature off)', async () => {
	const client = await applyMigration(PRE_0039_DDL, MIGRATION, SEED);
	const cols = await client.execute('PRAGMA table_info(channels)');
	const names = cols.rows.map((row) => row.name);
	for (const col of FEEDBACK_COLUMNS) {
		expect(names).toContain(col);
		expect(cols.rows.find((row) => row.name === col)?.notnull, `${col} must stay nullable`).toBe(0);
	}
	expect(cols.rows).toHaveLength(28);
	const { rows } = await client.execute(
		`SELECT ${FEEDBACK_COLUMNS.join(', ')} FROM channels WHERE id = 'UCexisting'`
	);
	expect(Object.values(rows[0])).toEqual(FEEDBACK_COLUMNS.map(() => null));
});

test('0039 creates the digest chain; a digest row is writable', async () => {
	const client = await applyMigration(PRE_0039_DDL, MIGRATION, SEED);
	for (const table of ['feedback_digests', 'feedback_findings', 'finding_evidence']) {
		const info = await client.execute(`PRAGMA table_info(${table})`);
		expect(info.rows.length, `${table} must exist`).toBeGreaterThan(0);
		// Privacy contract: no author identity anywhere in the digest chain.
		const names = info.rows.map((row) => String(row.name));
		expect(names.some((n) => /author|handle|avatar/.test(n)), `${table} must not carry author columns`).toBe(false);
	}
	await client.execute(
		"INSERT INTO feedback_digests (channel_id, window_start, window_end, status) VALUES ('UCexisting', '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', 'complete')"
	);
	const { rows } = await client.execute('SELECT channel_id, status, comments_classified FROM feedback_digests');
	expect(rows).toEqual([
		{ channel_id: 'UCexisting', status: 'complete', comments_classified: 0 }
	]);
});

test('0039 digest chain cascades digest → findings → evidence', async () => {
	const client = await applyMigration(PRE_0039_DDL, MIGRATION, SEED);
	await client.execute(
		"INSERT INTO feedback_digests (id, channel_id, window_start, window_end, status) VALUES (1, 'UCexisting', 'a', 'b', 'complete')"
	);
	await client.execute(
		"INSERT INTO feedback_findings (id, digest_id, category, summary, supporter_count) VALUES (10, 1, 'question', '3 viewers asked: x', 3)"
	);
	await client.execute(
		"INSERT INTO finding_evidence (finding_id, comment_id, sanitized_excerpt) VALUES (10, 'c1', 'safe text')"
	);
	await client.execute('DELETE FROM feedback_digests WHERE id = 1');
	const findings = await client.execute('SELECT id FROM feedback_findings');
	const evidence = await client.execute('SELECT id FROM finding_evidence');
	expect(findings.rows).toEqual([]);
	expect(evidence.rows).toEqual([]);
});

test('0039 the window unique index rejects a duplicate digest for the same window', async () => {
	const client = await applyMigration(PRE_0039_DDL, MIGRATION, SEED);
	const insert =
		"INSERT INTO feedback_digests (channel_id, window_start, window_end, status) VALUES ('UCexisting', 'a', 'b', 'complete')";
	await client.execute(insert);
	await expect(client.execute(insert)).rejects.toThrow();
	// A different window on the same channel must still be writable.
	await client.execute(
		"INSERT INTO feedback_digests (channel_id, window_start, window_end, status) VALUES ('UCexisting', 'b', 'c', 'complete')"
	);
});

test('0039 evidence requires a real finding (FK enforced)', async () => {
	const client = await applyMigration(PRE_0039_DDL, MIGRATION, SEED);
	await expect(
		client.execute(
			"INSERT INTO finding_evidence (finding_id, comment_id, sanitized_excerpt) VALUES (999, 'c1', 'x')"
		)
	).rejects.toThrow();
});

test('0039 the tenancy contract still bites', async () => {
	const client = await applyMigration(PRE_0039_DDL, MIGRATION, SEED);
	await expectTenancyContract(client);
});
