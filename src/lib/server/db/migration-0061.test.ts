import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

afterEach(closeMigratedDbs);

test('contact message migration is additive, nullable, and never queues historical requests', async () => {
	const client = await applyMigration(`
		CREATE TABLE contact_submissions (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL);
	`, '0061_contact_message_delivery.sql', `
		INSERT INTO contact_submissions VALUES (1, 'Pending', 'pending@example.com', 'pending');
		INSERT INTO contact_submissions VALUES (2, 'Verified', 'verified@example.com', 'verified');
	`);
	const columns = (await client.execute('PRAGMA table_info(contact_submissions)')).rows;
	for (const name of ['message', 'notification_due_at', 'notification_claim', 'notification_sent_at']) {
		expect(columns.find(column => column.name === name)).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
	}
	expect((await client.execute('SELECT * FROM contact_submissions ORDER BY id')).rows).toEqual([
		{ id: 1, name: 'Pending', email: 'pending@example.com', status: 'pending', message: null, notification_due_at: null, notification_claim: null, notification_sent_at: null },
		{ id: 2, name: 'Verified', email: 'verified@example.com', status: 'verified', message: null, notification_due_at: null, notification_claim: null, notification_sent_at: null }
	]);
	expect((await client.execute("PRAGMA index_info('contact_submissions_notification_due_idx')")).rows.map(row => row.name)).toEqual(['notification_due_at']);
	expect((await client.execute('PRAGMA integrity_check')).rows[0]).toEqual({ integrity_check: 'ok' });
	const journal = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
	expect(journal.entries.find((entry: { idx: number }) => entry.idx === 61)).toMatchObject({ idx: 61, tag: '0061_contact_message_delivery' });
});
