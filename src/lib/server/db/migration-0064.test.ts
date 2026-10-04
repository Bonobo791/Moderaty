import { afterEach, expect, test } from 'vitest';
import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

afterEach(closeMigratedDbs);

test('fair scheduler migration creates a constrained singleton without changing channel health', async () => {
	const client = await applyMigration(
		'CREATE TABLE channels (id TEXT PRIMARY KEY, last_run_at TEXT, last_success_at TEXT);',
		'0064_cron_workload_fairness.sql',
		"INSERT INTO channels VALUES ('UC-live', 'last-attempt', 'last-success');"
	);
	expect((await client.execute('SELECT * FROM channels')).rows).toEqual([
		{ id: 'UC-live', last_run_at: 'last-attempt', last_success_at: 'last-success' }
	]);
	await client.execute('INSERT INTO cron_workload_state (id) VALUES (1)');
	expect((await client.execute('SELECT * FROM cron_workload_state')).rows).toEqual([{ id: 1, next_workload: 'preview' }]);
	await expect(client.execute("INSERT INTO cron_workload_state VALUES (2, 'live')")).rejects.toThrow(/CHECK/);
	await expect(client.execute("UPDATE cron_workload_state SET next_workload = 'unknown'")).rejects.toThrow(/CHECK/);
	await client.execute("UPDATE cron_workload_state SET next_workload = 'live'");
	expect((await client.execute('PRAGMA integrity_check')).rows).toEqual([{ integrity_check: 'ok' }]);
});
