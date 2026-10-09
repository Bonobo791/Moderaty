import { expect, test } from 'vitest';
import { setupTestDb, testDb } from './testdb';
import { channelAllowedHandles } from './db/schema';
import { loadProtectedIdentities } from './allowlist';
setupTestDb(['channel_allowed_handles']);

test('protection follows the current handle holder each run without retaining channel IDs', async () => {
	await testDb().db.insert(channelAllowedHandles).values({channelId:'owner', handle:'protected_handle'});
	const before = await loadProtectedIdentities('owner', undefined, async () => 'first-holder');
	const after = await loadProtectedIdentities('owner', undefined, async () => 'next-holder');
	expect(before.byChannelId).toEqual(new Map([['first-holder', 'protected_handle']]));
	expect(after.byChannelId).toEqual(new Map([['next-holder', 'protected_handle']]));
	expect(after.unresolved).toBe(false);
	const stored = await testDb().db.select().from(channelAllowedHandles).all();
	expect(stored[0]).not.toHaveProperty('resolvedChannelId');
	expect(JSON.stringify(stored)).not.toMatch(/first-holder|next-holder/);
});
