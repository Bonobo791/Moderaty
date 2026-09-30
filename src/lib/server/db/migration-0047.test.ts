import { afterEach, expect, test } from 'vitest';

import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

const MIGRATION = '0047_zero_credit_retention.sql';

const PRE_0047_DDL = `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		google_sub TEXT NOT NULL UNIQUE,
		email TEXT NOT NULL,
		display_name TEXT NOT NULL,
		plan TEXT NOT NULL DEFAULT 'free',
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
`;

const SEED = `
	INSERT INTO users (id, google_sub, email, display_name)
	VALUES ('user-1', 'sub-1', 'one@example.com', 'One');
`;

afterEach(closeMigratedDbs);

test('0047 adds nullable zero-credit countdown columns to users', async () => {
	const client = await applyMigration(PRE_0047_DDL, MIGRATION, SEED);
	const info = await client.execute('PRAGMA table_info(users)');
	const names = info.rows.map((row) => String(row.name));
	for (const name of ['zero_credits_since', 'zero_credits_notified_at', 'zero_credits_checked_at']) {
		expect(names).toContain(name);
		const column = info.rows.find((row) => row.name === name);
		expect(column?.notnull, `${name} must be nullable`).toBe(0);
		expect(column?.dflt_value, `${name} must have no default`).toBeNull();
	}

	// Existing rows keep their data and start outside the countdown (NULL since).
	const rows = await client.execute('SELECT id, zero_credits_since, zero_credits_notified_at, zero_credits_checked_at FROM users');
	expect(rows.rows).toEqual([
		{ id: 'user-1', zero_credits_since: null, zero_credits_notified_at: null, zero_credits_checked_at: null }
	]);

	const indexes = await client.execute('PRAGMA index_list(users)');
	expect(indexes.rows.map((row) => row.name)).toContain('users_zero_credits_checked_idx');
});
