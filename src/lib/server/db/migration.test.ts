import { createClient } from '@libsql/client/node';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('upgrades an existing database with scan state and moderation actions', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'moderaty-migration-'));
	const client = createClient({ url: `file:${join(directory, 'moderaty.db')}` });
	try {
		await client.executeMultiple(`
			CREATE TABLE channels (
				id text PRIMARY KEY,
				title text NOT NULL,
				refresh_token_enc text NOT NULL,
				cursor text,
				active integer NOT NULL DEFAULT 1,
				created_at text NOT NULL
			);
			INSERT INTO channels (id, title, refresh_token_enc, cursor, active, created_at)
			VALUES ('UC-existing', 'Existing channel', 'encrypted', '2026-01-01T00:00:00.000Z', 1, '2026-01-01T00:00:00.000Z');
		`);

		await client.executeMultiple(await readFile(new URL('../../../../drizzle/0000_add_channel_scan_state.sql', import.meta.url), 'utf8'));
		await client.executeMultiple(await readFile(new URL('../../../../drizzle/0001_add_moderation_actions.sql', import.meta.url), 'utf8'));

		const columns = await client.execute('PRAGMA table_info(channels)');
		const channel = await client.execute('SELECT id, next_page_token, scan_cursor FROM channels');
		const actionColumns = await client.execute('PRAGMA table_info(moderation_actions)');
		expect(columns.rows.map((column) => column.name)).toEqual(expect.arrayContaining(['next_page_token', 'scan_cursor']));
		expect(channel.rows).toEqual([{ id: 'UC-existing', next_page_token: null, scan_cursor: null }]);
		expect(actionColumns.rows.map((column) => column.name)).toEqual(expect.arrayContaining([
			'comment_id',
			'channel_id',
			'action',
			'reason',
			'state',
			'last_attempt_at',
			'last_manual_retry_at',
			'created_at'
		]));

		const indexes = await client.execute('PRAGMA index_list(moderation_actions)');
		expect(indexes.rows.map((row) => row.name)).toContain('moderation_actions_channel_state_idx');

		await client.execute(`
			INSERT INTO moderation_actions (comment_id, channel_id, action, reason, state)
			VALUES ('comment-1', 'UC-existing', 'hold', 'rule #1 (keyword)', 'pending')
		`);
		const inserted = await client.execute('SELECT created_at FROM moderation_actions WHERE comment_id = \'comment-1\'');
		expect(inserted.rows[0]?.created_at).toEqual(expect.any(String));
	} finally {
		client.close();
		await rm(directory, { recursive: true, force: true });
	}
});
