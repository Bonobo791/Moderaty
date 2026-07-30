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

import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createTestDb, type TestDb } from '$lib/server/testdb';
import { rules } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('$lib/server/db', () => ({
	get db() {
		return mocks.db;
	}
}));

import { actions } from './+page.server';

let testDb: TestDb;

beforeAll(async () => {
	testDb = await createTestDb();
	mocks.db = testDb.db;
});

beforeEach(async () => {
	await testDb.client.execute('DELETE FROM rules');
});

function post(fields: Record<string, string>): Request {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return new Request('http://localhost/channels/UC1/rules?/remove', { method: 'POST', body: form });
}

async function seedRule(channelId: string): Promise<number> {
	const rows = await testDb.db
		.insert(rules)
		.values({ channelId, type: 'keyword', pattern: 'spam', action: 'hold' })
		.returning({ id: rules.id });
	return rows[0].id;
}

test('remove deletes this channel rule and reports ok', async () => {
	const id = await seedRule('UC1');
	const res = await actions.remove({ params: { id: 'UC1' }, request: post({ ruleId: String(id) }) } as never);
	expect(res).toMatchObject({ ok: true });
	expect(await testDb.db.select().from(rules).all()).toHaveLength(0);
});

test('remove cannot delete another channel rule', async () => {
	const otherId = await seedRule('UC2');
	const res = await actions.remove({
		params: { id: 'UC1' },
		request: post({ ruleId: String(otherId) })
	} as never);
	expect(res).toMatchObject({ status: 404 });
	expect(await testDb.db.select().from(rules).all()).toHaveLength(1);
});

test('remove rejects a malformed ruleId with 400', async () => {
	const id = await seedRule('UC1');
	for (const ruleId of ['abc', '', '0', '-3']) {
		const res = await actions.remove({ params: { id: 'UC1' }, request: post({ ruleId }) } as never);
		expect(res).toMatchObject({ status: 400 });
	}
	expect(await testDb.db.select().from(rules).all()).toHaveLength(1);
	expect((await testDb.db.select().from(rules).all())[0].id).toBe(id);
});
