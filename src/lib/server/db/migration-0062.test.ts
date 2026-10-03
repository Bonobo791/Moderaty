import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createTestDb } from '../testdb';
import { migrationStatements } from './migrationTestUtils';

test('welcome migration expands the complete current-main schema without enrolling historical users', async () => {
	// testdb retains the main schema's complete DDL. Removing only the new
	// table reconstructs the pre-0062 shape; no remote environment is used.
	const { client } = await createTestDb();
	try {
		await client.execute('DROP TABLE welcome_emails');
		await client.execute("INSERT INTO users (id, google_sub, email, display_name) VALUES ('old', 'old-sub', 'old@example.com', 'Old')");
		const before = (await client.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")).rows;
		for (const statement of migrationStatements('0062_hosted_welcome_email.sql')) await client.execute(statement);
		const after = (await client.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'welcome_emails' ORDER BY name")).rows;
		expect(after).toEqual(before);
		expect((await client.execute('SELECT count(*) AS n FROM welcome_emails')).rows[0].n).toBe(0);
		await client.execute("INSERT INTO welcome_emails (user_id, campaign, template_version, state, source, message_id) VALUES ('old', 'hosted-signup-welcome', 1, 'historical_unknown', 'historical_unknown', '<test@moderaty.com>')");
		expect((await client.execute('SELECT state, queued_at, accepted_at, attempts, suppression_reason FROM welcome_emails')).rows[0]).toEqual({ state: 'historical_unknown', queued_at: null, accepted_at: null, attempts: 0, suppression_reason: null });
		await expect(client.execute("INSERT INTO welcome_emails (user_id, campaign, template_version, state, source, message_id) VALUES ('old', 'hosted-signup-welcome', 2, 'queued', 'signup', '<second@moderaty.com>')")).rejects.toThrow(/UNIQUE/);
		await expect(client.execute("UPDATE welcome_emails SET state = 'garbage'")).rejects.toThrow(/welcome_emails_state/);
		await expect(client.execute("UPDATE welcome_emails SET user_id = 'missing'")).rejects.toThrow(/FOREIGN KEY/);
		expect((await client.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
		expect((await client.execute('PRAGMA integrity_check')).rows).toEqual([{ integrity_check: 'ok' }]);
		const indexNames = (await client.execute("PRAGMA index_list('welcome_emails')")).rows.map(row => row.name);
		expect(indexNames).toEqual(expect.arrayContaining(['welcome_emails_due_idx', 'welcome_emails_lease_idx']));
		const journal = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
		expect(journal.entries.find((entry: { idx: number }) => entry.idx === 62)).toMatchObject({ tag: '0062_hosted_welcome_email' });
	} finally { client.close(); }
});
