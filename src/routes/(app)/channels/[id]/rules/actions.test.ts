// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { expect, test } from 'vitest';
import { TEST_OWNER, postForm, setupTestDb, testDb } from '$lib/server/testdb';
import { channelAllowedHandles, channels, rules } from '$lib/server/db/schema';

import { actions, load } from './+page.server';

setupTestDb(['rules', 'channels', 'channel_allowed_handles']);

const OWNER = TEST_OWNER;

async function seedChannel(channelId: string, userId: string | null = OWNER.id, orgId: string | null = 'org-1') {
	await testDb().db.insert(channels).values({ id: channelId, userId, orgId, title: 'Ch', refreshTokenEnc: 'enc' });
}

const RULES_URL = 'http://localhost/channels/UC1/rules?/remove';

async function seedRule(channelId: string): Promise<number> {
	const rows = await testDb()
		.db.insert(rules)
		.values({ channelId, type: 'keyword', pattern: 'spam', action: 'hold' })
		.returning({ id: rules.id });
	return rows[0].id;
}

function remove(channelId: string, ruleId: string, user: typeof OWNER | null = OWNER) {
	return actions.remove({ params: { id: channelId }, request: postForm({ ruleId }, RULES_URL), locals: { user } } as never);
}

async function ruleRows() {
	return testDb().db.select().from(rules).all();
}

test('load returns the maintenance payload during a database outage instead of a 401', async () => {
	// The layout renders the overlay; the child load must not throw on the
	// null-user outage shape.
	const result = await load({ params: { id: 'UC1' }, locals: { user: null, dbDown: true } } as never);
	expect(result).toEqual({ ch: { id: 'UC1', title: '' }, rs: [], handles: [], maintenance: true });
});

test('load projects only the channel fields the page renders — never the credential', async () => {
	await seedChannel('UC1');
	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	expect(result?.ch).toEqual({ id: 'UC1', title: 'Ch' });
	expect(result?.ch).not.toHaveProperty('refreshTokenEnc');
});

test('remove deletes this channel rule and reports ok', async () => {
	await seedChannel('UC1');
	const id = await seedRule('UC1');
	const res = await remove('UC1', String(id));
	expect(res).toMatchObject({ ok: true });
	expect(await ruleRows()).toHaveLength(0);
});

test('remove cannot delete another channel rule', async () => {
	await seedChannel('UC1');
	await seedChannel('UC2');
	const otherId = await seedRule('UC2');
	const res = await remove('UC1', String(otherId));
	expect(res).toMatchObject({ status: 404, data: { error: 'rule not found' } });
	expect(await ruleRows()).toHaveLength(1);
});

test('remove rejects a malformed ruleId with 400', async () => {
	await seedChannel('UC1');
	const id = await seedRule('UC1');
	for (const ruleId of ['abc', '', '0', '-3']) {
		const res = await remove('UC1', ruleId);
		expect(res).toMatchObject({ status: 400, data: { error: 'Invalid rule ID' } });
	}
	const rows = await ruleRows();
	expect(rows).toHaveLength(1);
	expect(rows[0].id).toBe(id);
});

test('remove on a channel owned by another team fails with 404', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');
	const id = await seedRule('UC1');

	await expect(remove('UC1', String(id))).rejects.toMatchObject({ status: 404 });
	expect(await ruleRows()).toHaveLength(1);
});

test('remove rejects a signed-out request with 401', async () => {
	await seedChannel('UC1');
	const id = await seedRule('UC1');

	await expect(remove('UC1', String(id), null)).rejects.toMatchObject({ status: 401 });
	expect(await ruleRows()).toHaveLength(1);
});

function add(channelId: string, user: typeof OWNER | null = OWNER) {
	return actions.add({
		params: { id: channelId },
		request: postForm({ type: 'keyword', pattern: 'spam', action: 'hold' }, 'http://localhost/channels/UC1/rules?/add'),
		locals: { user }
	} as never);
}

test('add on a channel owned by another team fails with 404 and inserts nothing', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');

	await expect(add('UC1')).rejects.toMatchObject({ status: 404 });
	expect(await ruleRows()).toHaveLength(0);
});

test('add rejects a signed-out request with 401 and inserts nothing', async () => {
	await seedChannel('UC1');

	await expect(add('UC1', null)).rejects.toMatchObject({ status: 401 });
	expect(await ruleRows()).toHaveLength(0);
});

test('load returns only this channel rules with the projected channel', async () => {
	await seedChannel('UC1');
	await seedChannel('UC2');
	const id = await seedRule('UC1');
	await seedRule('UC2');

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	expect(result).toEqual({
		ch: { id: 'UC1', title: 'Ch' },
		rs: [expect.objectContaining({ id, channelId: 'UC1', type: 'keyword', pattern: 'spam', action: 'hold' })],
		handles: []
	});
});

test('load on a channel owned by another team fails with 404', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');

	await expect(load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never)).rejects.toMatchObject({
		status: 404
	});
});

function addForm(channelId: string, fields: Record<string, string>, user: typeof OWNER | null = OWNER) {
	return actions.add({
		params: { id: channelId },
		request: postForm(fields, 'http://localhost/channels/UC1/rules?/add'),
		locals: { user }
	} as never);
}

test('add validates, trims the pattern, and inserts the rule', async () => {
	await seedChannel('UC1');

	const res = await addForm('UC1', { type: 'keyword', pattern: '  spam  ', action: 'hold' });
	expect(res).toEqual({ ok: true });

	const rows = await ruleRows();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ channelId: 'UC1', type: 'keyword', pattern: 'spam', action: 'hold' });
	expect(rows[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('add rejects an unsupported rule type with the validator message and inserts nothing', async () => {
	await seedChannel('UC1');

	const res = await addForm('UC1', { type: 'banana', pattern: 'spam', action: 'hold' });
	expect(res).toMatchObject({ status: 400, data: { error: 'rule #0 has an unsupported type: banana' } });
	expect(await ruleRows()).toHaveLength(0);
});

test('add rejects an unsupported rule action with the validator message and inserts nothing', async () => {
	await seedChannel('UC1');

	const res = await addForm('UC1', { type: 'keyword', pattern: 'spam', action: 'nuke' });
	expect(res).toMatchObject({ status: 400, data: { error: 'rule #0 has an unsupported action: nuke' } });
	expect(await ruleRows()).toHaveLength(0);
});

test('add rejects an unsafe regex with the validator message and inserts nothing', async () => {
	await seedChannel('UC1');

	const res = await addForm('UC1', { type: 'regex', pattern: '(a|a)+', action: 'hold' });
	expect(res).toMatchObject({ status: 400, data: { error: 'rule #0 has an unsafe regex' } });
	expect(await ruleRows()).toHaveLength(0);
});

test('add rejects a whitespace-only pattern as empty and inserts nothing', async () => {
	await seedChannel('UC1');

	const res = await addForm('UC1', { type: 'keyword', pattern: '   ', action: 'hold' });
	expect(res).toMatchObject({ status: 400, data: { error: 'rule #0 has an empty pattern' } });
	expect(await ruleRows()).toHaveLength(0);
});

test('add rejects missing form fields with the validator message and inserts nothing', async () => {
	await seedChannel('UC1');

	const noType = await addForm('UC1', { pattern: 'spam', action: 'hold' });
	expect(noType).toMatchObject({ status: 400, data: { error: 'rule #0 has an unsupported type: ' } });

	const noAction = await addForm('UC1', { type: 'keyword', pattern: 'spam' });
	expect(noAction).toMatchObject({ status: 400, data: { error: 'rule #0 has an unsupported action: ' } });

	const noPattern = await addForm('UC1', { type: 'keyword', action: 'hold' });
	expect(noPattern).toMatchObject({ status: 400, data: { error: 'rule #0 has an empty pattern' } });

	expect(await ruleRows()).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Protected handles (channel_allowed_handles)
// ---------------------------------------------------------------------------

async function seedHandle(channelId: string, handle: string): Promise<number> {
	const rows = await testDb()
		.db.insert(channelAllowedHandles)
		.values({ channelId, handle })
		.returning({ id: channelAllowedHandles.id });
	return rows[0].id;
}

async function handleRows() {
	return testDb().db.select().from(channelAllowedHandles).all();
}

function addHandle(channelId: string, handle: string, user: typeof OWNER | null = OWNER) {
	return actions.addHandle({
		params: { id: channelId },
		request: postForm({ handle }, 'http://localhost/channels/UC1/rules?/addHandle'),
		locals: { user }
	} as never);
}

function removeHandle(channelId: string, handleId: string, user: typeof OWNER | null = OWNER) {
	return actions.removeHandle({
		params: { id: channelId },
		request: postForm({ handleId }, 'http://localhost/channels/UC1/rules?/removeHandle'),
		locals: { user }
	} as never);
}

test('load returns this channel protected handles, newest first', async () => {
	await seedChannel('UC1');
	await seedChannel('UC2');
	const first = await seedHandle('UC1', 'first-handle');
	const second = await seedHandle('UC1', 'second-handle');
	await seedHandle('UC2', 'other-channel');

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	expect(result?.handles.map((row) => row.id)).toEqual([second, first]);
});

test('addHandle validates, normalizes, and stores the handle', async () => {
	await seedChannel('UC1');

	const res = await addHandle('UC1', '  @SomeUser ');
	expect(res).toEqual({ ok: true });

	expect(await handleRows()).toEqual([expect.objectContaining({ channelId: 'UC1', handle: 'someuser' })]);
});

test('addHandle rejects an invalid handle with 400 and inserts nothing', async () => {
	await seedChannel('UC1');

	const res = await addHandle('UC1', 'no spaces allowed');
	expect(res).toMatchObject({
		status: 400,
		data: { error: expect.stringContaining('handle may only contain') }
	});
	expect(await handleRows()).toEqual([]);
});

test('addHandle rejects the 101st handle with 400 and keeps the existing 100', async () => {
	await seedChannel('UC1');
	await testDb().db.insert(channelAllowedHandles).values(
		Array.from({ length: 100 }, (_, index) => ({ channelId: 'UC1', handle: `handle${index}` }))
	);

	const res = await addHandle('UC1', 'one-more');
	expect(res).toMatchObject({ status: 400, data: { error: expect.stringContaining('maximum of 100') } });
	expect(await handleRows()).toHaveLength(100);
});

test('addHandle on a channel owned by another team fails with 404 and inserts nothing', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');

	await expect(addHandle('UC1', 'someuser')).rejects.toMatchObject({ status: 404 });
	expect(await handleRows()).toHaveLength(0);
});

test('addHandle rejects a signed-out request with 401 and inserts nothing', async () => {
	await seedChannel('UC1');

	await expect(addHandle('UC1', 'someuser', null)).rejects.toMatchObject({ status: 401 });
	expect(await handleRows()).toHaveLength(0);
});

test('removeHandle deletes this channel handle and reports ok', async () => {
	await seedChannel('UC1');
	const id = await seedHandle('UC1', 'someuser');

	const res = await removeHandle('UC1', String(id));
	expect(res).toMatchObject({ ok: true });
	expect(await handleRows()).toHaveLength(0);
});

test('removeHandle cannot delete another channel handle', async () => {
	await seedChannel('UC1');
	await seedChannel('UC2');
	const otherId = await seedHandle('UC2', 'someuser');

	const res = await removeHandle('UC1', String(otherId));
	expect(res).toMatchObject({ status: 404, data: { error: 'protected handle not found' } });
	expect(await handleRows()).toHaveLength(1);
});

test('removeHandle rejects a malformed handleId with 400', async () => {
	await seedChannel('UC1');
	const id = await seedHandle('UC1', 'someuser');

	for (const handleId of ['abc', '', '0', '-3']) {
		const res = await removeHandle('UC1', handleId);
		expect(res).toMatchObject({ status: 400, data: { error: 'Invalid handle ID' } });
	}
	const rows = await handleRows();
	expect(rows).toHaveLength(1);
	expect(rows[0].id).toBe(id);
});

test('removeHandle on a channel owned by another team fails with 404 and the row survives', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');
	const id = await seedHandle('UC1', 'someuser');

	await expect(removeHandle('UC1', String(id))).rejects.toMatchObject({ status: 404 });
	expect(await handleRows()).toHaveLength(1);
});

test('removeHandle rejects a signed-out request with 401 and the row survives', async () => {
	await seedChannel('UC1');
	const id = await seedHandle('UC1', 'someuser');

	await expect(removeHandle('UC1', String(id), null)).rejects.toMatchObject({ status: 401 });
	expect(await handleRows()).toHaveLength(1);
});
