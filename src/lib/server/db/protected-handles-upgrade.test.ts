import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('the privacy migration removes resolved IDs, retains newest duplicates and enforces per-channel uniqueness', async () => {
	const client = createClient({url:'file::memory:'});
	try {
		await client.executeMultiple(`CREATE TABLE channel_allowed_handles (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, handle TEXT NOT NULL, resolved_channel_id TEXT, created_at TEXT NOT NULL);
		INSERT INTO channel_allowed_handles VALUES (1,'owner','handle','old-holder','old'), (2,'owner','handle','new-holder','new'), (3,'other-owner','handle','other-holder','other');`);
		const migration = readFileSync(new URL('../../../../drizzle/0072_protected_handles_memory_only.sql', import.meta.url), 'utf8');
		for (const statement of migration.split('--> statement-breakpoint')) await client.execute(statement);
		expect((await client.execute('SELECT * FROM channel_allowed_handles ORDER BY id')).rows).toEqual([
			{id:2, channel_id:'owner', handle:'handle', created_at:'new'}, {id:3, channel_id:'other-owner', handle:'handle', created_at:'other'}
		]);
		expect((await client.execute('PRAGMA table_info(channel_allowed_handles)')).rows.map(row => row.name)).not.toContain('resolved_channel_id');
		await expect(client.execute("INSERT INTO channel_allowed_handles (channel_id,handle,created_at) VALUES ('owner','handle','duplicate')")).rejects.toThrow(/UNIQUE/);
	} finally {client.close();}
});
