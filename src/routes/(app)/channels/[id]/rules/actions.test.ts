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
import { channels, rules } from '$lib/server/db/schema';

import { actions, load } from './+page.server';

setupTestDb(['rules', 'channels']);

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
	expect(result).toMatchObject({ maintenance: true, rs: [] });
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
	expect(res).toMatchObject({ status: 404 });
	expect(await ruleRows()).toHaveLength(1);
});

test('remove rejects a malformed ruleId with 400', async () => {
	await seedChannel('UC1');
	const id = await seedRule('UC1');
	for (const ruleId of ['abc', '', '0', '-3']) {
		const res = await remove('UC1', ruleId);
		expect(res).toMatchObject({ status: 400 });
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
