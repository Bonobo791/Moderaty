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
import { postForm, setupTestDb, testDb } from '$lib/server/testdb';
import { rules } from '$lib/server/db/schema';

import { actions } from './+page.server';

setupTestDb(['rules']);

const RULES_URL = 'http://localhost/channels/UC1/rules?/remove';

async function seedRule(channelId: string): Promise<number> {
	const rows = await testDb()
		.db.insert(rules)
		.values({ channelId, type: 'keyword', pattern: 'spam', action: 'hold' })
		.returning({ id: rules.id });
	return rows[0].id;
}

function remove(channelId: string, ruleId: string) {
	return actions.remove({ params: { id: channelId }, request: postForm({ ruleId }, RULES_URL) } as never);
}

async function ruleRows() {
	return testDb().db.select().from(rules).all();
}

test('remove deletes this channel rule and reports ok', async () => {
	const id = await seedRule('UC1');
	const res = await remove('UC1', String(id));
	expect(res).toMatchObject({ ok: true });
	expect(await ruleRows()).toHaveLength(0);
});

test('remove cannot delete another channel rule', async () => {
	const otherId = await seedRule('UC2');
	const res = await remove('UC1', String(otherId));
	expect(res).toMatchObject({ status: 404 });
	expect(await ruleRows()).toHaveLength(1);
});

test('remove rejects a malformed ruleId with 400', async () => {
	const id = await seedRule('UC1');
	for (const ruleId of ['abc', '', '0', '-3']) {
		const res = await remove('UC1', ruleId);
		expect(res).toMatchObject({ status: 400 });
	}
	const rows = await ruleRows();
	expect(rows).toHaveLength(1);
	expect(rows[0].id).toBe(id);
});
