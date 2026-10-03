import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { expect, test } from 'vitest';

test('restore-intent migration leaves legacy restoring rows unbound and preserves their audit history', async () => {
	const client = createClient({ url: 'file::memory:' });
	try {
		await client.executeMultiple(`CREATE TABLE comments (id TEXT PRIMARY KEY, status TEXT NOT NULL);
			INSERT INTO comments VALUES ('legacy', 'restoring');
			CREATE TABLE audit_log (id INTEGER PRIMARY KEY, comment_id TEXT, action TEXT);
			INSERT INTO audit_log VALUES (1, 'legacy', 'ban');`);
		await client.executeMultiple(readFileSync(new URL('../../../../drizzle/0065_restore_intent_binding.sql', import.meta.url), 'utf8'));
		expect((await client.execute('SELECT * FROM comments')).rows).toEqual([{ id: 'legacy', status: 'restoring', restore_intent_id: null }]);
		expect((await client.execute('SELECT * FROM audit_log')).rows).toEqual([{ id: 1, comment_id: 'legacy', action: 'ban' }]);
	} finally {
		client.close();
	}
});
