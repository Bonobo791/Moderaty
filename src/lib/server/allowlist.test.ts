import { expect, test } from 'vitest';
import { setupTestDb, testDb } from '$lib/server/testdb';
import { channelAllowedHandles } from '$lib/server/db/schema';

import {
	MAX_HANDLES_PER_CHANNEL,
	addHandle,
	listHandles,
	loadHandleSet,
	normalizeHandle,
	removeHandle,
	validateHandle
} from './allowlist';

setupTestDb(['channel_allowed_handles']);

async function rows() {
	return testDb().db.select().from(channelAllowedHandles).all();
}

test.each([
	{ raw: 'someuser', expected: 'someuser' },
	{ raw: '  @SomeUser  ', expected: 'someuser' },
	{ raw: '@USER.name_1-x', expected: 'user.name_1-x' },
	// Only ONE leading '@' is stripped: a doubled prefix keeps the second '@'
	// (and then fails validation, loudly, at the form).
	{ raw: '@@some', expected: '@some' },
	// Inner whitespace is NOT collapsed: YouTube handles cannot contain spaces,
	// so the value survives normalization and fails the character check.
	{ raw: 'so me', expected: 'so me' }
])('normalizeHandle($raw) is $expected', ({ raw, expected }) => {
	expect(normalizeHandle(raw)).toBe(expected);
});

test.each([
	{ raw: '@Valid.User_1-x', expected: 'valid.user_1-x' },
	{ raw: 'abc', expected: 'abc' },
	{ raw: 'a'.repeat(30), expected: 'a'.repeat(30) }
])('validateHandle($raw) returns the normalized handle', ({ raw, expected }) => {
	expect(validateHandle(raw)).toBe(expected);
});

test.each([
	{ raw: '', reason: 'handle is empty' },
	{ raw: '   ', reason: 'handle is empty' },
	{ raw: '@', reason: 'handle is empty' },
	{ raw: 'ab', reason: 'handle must be between 3 and 30 characters' },
	{ raw: 'a'.repeat(31), reason: 'handle must be between 3 and 30 characters' },
	{ raw: 'so me', reason: 'handle may only contain' },
	{ raw: 'üsername', reason: 'handle may only contain' },
	{ raw: 'user!', reason: 'handle may only contain' },
	{ raw: '@@some', reason: 'handle may only contain' }
])('validateHandle rejects $raw ($reason)', ({ raw, reason }) => {
	expect(() => validateHandle(raw)).toThrow(reason);
});

test('addHandle validates, normalizes, inserts, and returns the stored row', async () => {
	const row = await addHandle('UC1', '  @SomeUser ');

	expect(row).toMatchObject({ channelId: 'UC1', handle: 'someuser' });
	expect(await rows()).toEqual([expect.objectContaining({ channelId: 'UC1', handle: 'someuser' })]);
});

test('addHandle rejects an invalid handle and inserts nothing', async () => {
	await expect(addHandle('UC1', 'no spaces allowed')).rejects.toThrow('handle may only contain');
	expect(await rows()).toEqual([]);
});

test('addHandle is idempotent: re-adding the same normalized handle returns the existing row', async () => {
	const first = await addHandle('UC1', 'someuser');
	const second = await addHandle('UC1', '@SOMEUSER');

	expect(second).toMatchObject({ id: first.id, handle: 'someuser' });
	expect(await rows()).toHaveLength(1);
});

test('addHandle throws loudly at the per-channel maximum', async () => {
	await testDb().db.insert(channelAllowedHandles).values(
		Array.from({ length: MAX_HANDLES_PER_CHANNEL }, (_, index) => ({
			channelId: 'UC1',
			handle: `handle${index}`
		}))
	);

	await expect(addHandle('UC1', 'one-more')).rejects.toThrow(
		`channel already has the maximum of ${MAX_HANDLES_PER_CHANNEL} protected handles`
	);
	expect(await rows()).toHaveLength(MAX_HANDLES_PER_CHANNEL);
});

test('duplicates remain idempotent at capacity without a resolver', async () => {
	await testDb().db.insert(channelAllowedHandles).values(Array.from({length: 100}, (_, index) => ({channelId: 'UC1', handle: `handle-${index}`})));
	expect(await addHandle('UC1', '@HANDLE-0')).toMatchObject({handle: 'handle-0'});
	expect(await rows()).toHaveLength(100);
});

test('the same handle can be protected on two different channels', async () => {
	await addHandle('UC1', 'someuser');
	await addHandle('UC2', '@SomeUser');

	expect(await rows()).toHaveLength(2);
});

test('listHandles returns this channel handles only, newest first', async () => {
	const first = await addHandle('UC1', 'first-handle');
	const second = await addHandle('UC1', 'second-handle');
	await addHandle('UC2', 'other-channel');

	const listed = await listHandles('UC1');

	expect(listed.map((row) => row.id)).toEqual([second.id, first.id]);
});

test('removeHandle deletes this channel row and returns it', async () => {
	const row = await addHandle('UC1', 'someuser');

	const removed = await removeHandle('UC1', row.id);

	expect(removed).toMatchObject({ id: row.id, handle: 'someuser' });
	expect(await rows()).toEqual([]);
});

test('removeHandle is channel-scoped: another channel row signals a miss and survives', async () => {
	const row = await addHandle('UC2', 'someuser');

	const removed = await removeHandle('UC1', row.id);

	expect(removed).toBeNull();
	expect(await rows()).toEqual([expect.objectContaining({ id: row.id })]);
});

test.each([0, -3, 1.5, Number.NaN])('removeHandle rejects the malformed id %s', async (id) => {
	const row = await addHandle('UC1', 'someuser');

	await expect(removeHandle('UC1', id)).rejects.toThrow('Invalid handle ID');
	expect(await rows()).toHaveLength(1);
	expect((await rows())[0].id).toBe(row.id);
});

test('loadHandleSet returns this channel normalized handles as a Set', async () => {
	await addHandle('UC1', '@SomeUser');
	await addHandle('UC1', 'other.user');
	await addHandle('UC2', 'not-this-channel');

	const set = await loadHandleSet('UC1');

	expect(set).toEqual(new Set(['someuser', 'other.user']));
});

test('verification at capacity preserves the entered handle without storing identity', async () => {
	await testDb().db.insert(channelAllowedHandles).values(Array.from({ length: 100 }, (_, index) => ({ channelId: 'UC1', handle: `handle-${index}` })));
	await addHandle('UC1', 'handle-0', async () => 'verified-author');
	const stored = await rows();
	expect(stored).toHaveLength(100);
	expect(stored.find(row => row.handle === 'handle-0')).not.toHaveProperty('resolvedChannelId');
	expect(JSON.stringify(stored)).not.toContain('verified-author');
});

test('failed explicit resolution retains the unresolved row and original configuration', async () => {
	await addHandle('UC1', 'legacy-handle');
	const before = await rows();
	await expect(addHandle('UC1', 'legacy-handle', async () => { throw new Error('lookup unavailable'); })).rejects.toThrow('lookup unavailable');
	expect(await rows()).toEqual(before);
});

test('duplicate verification discards a different current holder without rebinding stored data', async () => {
	const original = await addHandle('UC1', 'legacy-handle', async () => 'first-holder');
	await addHandle('UC1', 'legacy-handle', async () => 'later-holder');
	expect(await rows()).toEqual([original]);
	expect(original).not.toHaveProperty('resolvedChannelId');
});

test('removal during external resolution cannot report an added protection', async () => {
	const original = await addHandle('UC1', 'legacy-handle');
	await expect(addHandle('UC1', 'legacy-handle', async () => {
		await removeHandle('UC1', original.id);
		return 'verified-author';
	})).rejects.toThrow('removed during resolution');
	expect(await rows()).toEqual([]);
});

test('concurrent resolved adds cannot exceed the cap after awaiting the provider', async () => {
	await testDb().db.insert(channelAllowedHandles).values(Array.from({ length: 99 }, (_, index) => ({ channelId: 'UC1', handle: `handle-${index}` })));
	const bothStarted = Promise.withResolvers<void>();
	let started = 0;
	const resolve = async () => {
		if (++started === 2) bothStarted.resolve();
		await bothStarted.promise;
		return 'verified-author';
	};
	const results = await Promise.allSettled([addHandle('UC1', 'first-new', resolve), addHandle('UC1', 'second-new', resolve)]);
	expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
	expect(await rows()).toHaveLength(100);
});
