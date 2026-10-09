import { expect, test, vi } from 'vitest';
import { setupTestDb, testDb } from './testdb';
import { channelAllowedHandles } from './db/schema';
import { loadProtectedIdentities, loadProtectedAuthors } from './allowlist';
import { HandleNotFoundError } from './youtube';
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

test('an unassigned handle is authoritative absence and is retried next run', async () => {
	await testDb().db.insert(channelAllowedHandles).values({channelId:'owner', handle:'released_handle'});
	const absent = await loadProtectedIdentities('owner', undefined, async () => { throw new HandleNotFoundError(); });
	expect(absent.unresolved).toBe(false);
	expect(absent.byChannelId.size).toBe(0);
	const checked = await loadProtectedIdentities('owner', undefined, undefined, absent);
	expect(checked.unresolved).toBe(false);
	const assigned = await loadProtectedIdentities('owner', undefined, async () => 'new-holder');
	expect(assigned.byChannelId).toEqual(new Map([['new-holder', 'released_handle']]));
});

test('a provider outage logs one bounded summary while protection stays unresolved', async () => {
	await testDb().db.insert(channelAllowedHandles).values(['first_handle','second_handle'].map(handle => ({channelId:'owner',handle})));
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const result = await loadProtectedIdentities('owner', undefined, async () => {throw new Error('synthetic-outage');});
		expect(result.unresolved).toBe(true);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith('protected handle resolution failed; comments will be held for review', {channelId:'owner',failures:2}, expect.any(Error));
	} finally {log.mockRestore();}
});

test('page-scoped absence is not reused for a different author whose handle metadata is missing', async () => {
	await testDb().db.insert(channelAllowedHandles).values({channelId:'owner',handle:'protected_handle'});
	const resolve = vi.fn(async () => 'protected-author');
	const ordinary = await loadProtectedAuthors('owner', testDb().db, ['ordinary-author'], new Map([['ordinary-author','ordinary_handle']]), resolve);
	expect(resolve).not.toHaveBeenCalled();
	const protectedPage = await loadProtectedAuthors('owner', testDb().db, ['protected-author'], new Map(), resolve, ordinary);
	expect(resolve).toHaveBeenCalledWith('protected_handle');
	expect(protectedPage.byChannelId).toEqual(new Map([['protected-author','protected_handle']]));
});
