// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

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
