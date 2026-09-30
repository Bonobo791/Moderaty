import { afterEach, expect, test } from 'vitest';
import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

afterEach(closeMigratedDbs);

test('0050 adds nullable clustering metadata without altering historical digests', async () => {
	const client = await applyMigration(
		'CREATE TABLE feedback_digests (id INTEGER PRIMARY KEY, status TEXT NOT NULL);',
		'0050_feedback_clustering_recovery.sql',
		"INSERT INTO feedback_digests (id, status) VALUES (1, 'complete');"
	);
	const info = await client.execute('PRAGMA table_info(feedback_digests)');
	expect(info.rows.find((row) => row.name === 'clustering_degraded')).toMatchObject({ type: 'INTEGER', notnull: 0 });
	expect((await client.execute('SELECT * FROM feedback_digests')).rows).toEqual([{ id: 1, status: 'complete', clustering_degraded: null }]);
	await client.execute('INSERT INTO feedback_digests (id, status, clustering_degraded) VALUES (2, \'complete\', 1), (3, \'complete\', 0)');
	expect((await client.execute('SELECT clustering_degraded FROM feedback_digests ORDER BY id')).rows.map((row) => row.clustering_degraded)).toEqual([null, 1, 0]);
});
