import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createTestDb } from '../testdb';
import { migrationStatements } from './migrationTestUtils';

test('campaign pacing migration preserves recent attempts, active leases and outage cooldowns without user retention', async () => {
	const { client } = await createTestDb();
	try {
		await client.execute('DROP TABLE welcome_campaigns');
		await client.execute("INSERT INTO users (id, google_sub, email, display_name) VALUES ('old', 'old-sub', 'old@example.com', 'Old')");
		for (const [campaign, state, lastAttempt, lease, error, nextRetry] of [
			['recent', 'accepted', '2026-10-03T20:00:00.000Z', null, null, null],
			['active', 'in_flight', null, '2026-10-03T20:02:00.000Z', null, null],
			['outage', 'queued', null, null, 'tls', '2026-10-03T20:15:00.000Z']
		]) {
			await client.execute({ sql: 'INSERT INTO welcome_emails (user_id, campaign, template_version, state, source, message_id, last_attempt_at, lease_expires_at, last_error, next_retry_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)', args: ['old', campaign, state, 'signup', '<test@example.com>', lastAttempt, lease, error, nextRetry] });
		}
		const before = (await client.execute('SELECT * FROM welcome_emails ORDER BY campaign')).rows;
		for (const statement of migrationStatements('0063_welcome_campaign_pacing.sql')) await client.execute(statement);
		expect((await client.execute('SELECT * FROM welcome_emails ORDER BY campaign')).rows).toEqual(before);
		const pacing = (await client.execute('SELECT * FROM welcome_campaigns ORDER BY campaign')).rows;
		expect(pacing).toEqual([
			{ campaign: 'active', next_attempt_at: '2026-10-03T20:02:00.000Z' },
			{ campaign: 'outage', next_attempt_at: '2026-10-03T20:15:00.000Z' },
			{ campaign: 'recent', next_attempt_at: '2026-10-03T20:01:00.000Z' }
		]);
		await client.execute("DELETE FROM users WHERE id = 'old'");
		expect((await client.execute('SELECT * FROM welcome_emails')).rows).toEqual([]);
		expect((await client.execute('SELECT * FROM welcome_campaigns ORDER BY campaign')).rows).toEqual(pacing);
		expect((await client.execute('PRAGMA integrity_check')).rows).toEqual([{ integrity_check: 'ok' }]);
		const journal = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
		expect(journal.entries.find((entry: { idx: number }) => entry.idx === 63)).toMatchObject({ tag: '0063_welcome_campaign_pacing' });
	} finally { client.close(); }
});
