import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, test } from 'vitest';

// The build migrates before the old image stops; its explicit column query must still work.
test('the complete migration chain keeps the old image readable without retaining resolved identities', async () => {
	const client = createClient({url:'file::memory:'});
	try {
		await client.executeMultiple(readFileSync(new URL('../../../../e2e/support/legacy-base-schema.sql', import.meta.url), 'utf8'));
		await migrate(drizzle(client), {migrationsFolder:'drizzle'});
		await client.execute("INSERT INTO channel_allowed_handles (channel_id,handle,created_at) VALUES ('synthetic-owner','synthetic_handle','synthetic-time')");
		expect((await client.execute('SELECT resolved_channel_id FROM channel_allowed_handles')).rows).toEqual([{resolved_channel_id:null}]);
		expect((await client.execute('PRAGMA table_info(channel_allowed_handles)')).rows.find(row => row.name === 'resolved_channel_id')).toMatchObject({notnull:0});
	} finally {client.close();}
});
