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
import { channels } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

import { actions } from './+page.server';

setupTestDb(['channels']);

const OWNER = TEST_OWNER;

async function seedChannel(id: string, userId: string | null = OWNER.id, orgId: string | null = 'org-1') {
	await testDb().db.insert(channels).values({ id, userId, orgId, title: `Channel ${id}`, refreshTokenEnc: 'enc' });
}

function setToneLevel(channelId: string, toneLevel: string, user: typeof OWNER | null = OWNER) {
	return actions.setToneLevel({ request: postForm({ channelId, toneLevel }), locals: { user } } as never);
}

async function toneLevelOf(id: string) {
	const row = await testDb().db.select().from(channels).where(eq(channels.id, id)).get();
	return row?.toneLevel;
}

test.each([{ level: '1' }, { level: '2' }])('persists sensitivity level $level', async ({ level }) => {
	await seedChannel('UC1');

	const res = await setToneLevel('UC1', level);

	expect(res).toMatchObject({ ok: true });
	expect(await toneLevelOf('UC1')).toBe(Number(level));
});

test.each([{ level: '0' }, { level: '3' }, { level: 'x' }, { level: '' }])(
	'rejects invalid sensitivity level "$level" with 400 and changes nothing',
	async ({ level }) => {
		await seedChannel('UC1');

		const res = await setToneLevel('UC1', level);

		expect(res).toMatchObject({ status: 400 });
		expect(await toneLevelOf('UC1')).toBeNull();
	}
);

test('rejects an unknown channel with 404', async () => {
	const res = await setToneLevel('UC-missing', '2');

	expect(res).toMatchObject({ status: 404 });
});

test('rejects a channel owned by another team with 404 and changes nothing', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');

	const res = await setToneLevel('UC1', '2');

	expect(res).toMatchObject({ status: 404 });
	expect(await toneLevelOf('UC1')).toBeNull();
});

test('rejects a signed-out request with 401', async () => {
	await seedChannel('UC1');

	await expect(setToneLevel('UC1', '2', null)).rejects.toMatchObject({ status: 401 });
	expect(await toneLevelOf('UC1')).toBeNull();
});

function analyzeHistory(channelId: string, months: string, user: typeof OWNER | null = OWNER) {
	return actions.analyzeHistory({ request: postForm({ channelId, months }), locals: { user } } as never);
}

async function scanWindowOf(id: string) {
	const row = await testDb().db.select().from(channels).where(eq(channels.id, id)).get();
	return { cursor: row?.cursor, nextPageToken: row?.nextPageToken, scanCursor: row?.scanCursor };
}

test('analyze history moves the scan boundary N months back and resets the drain state', async () => {
	await seedChannel('UC1');
	await testDb()
		.db.update(channels)
		.set({ cursor: '2026-07-30T00:00:00.000Z', nextPageToken: 'tok', scanCursor: '2026-07-29T00:00:00.000Z' })
		.where(eq(channels.id, 'UC1'));

	const before = Date.now();
	const res = await analyzeHistory('UC1', '3');
	const after = Date.now();

	expect(res).toMatchObject({ ok: true });
	const { cursor, nextPageToken, scanCursor } = await scanWindowOf('UC1');
	expect(nextPageToken).toBeNull();
	expect(scanCursor).toBeNull();
	// 3 months ≈ 90 days back, computed at action time.
	const expected = 3 * 30 * 24 * 60 * 60 * 1000;
	expect(Date.parse(cursor ?? '')).toBeGreaterThanOrEqual(before - expected - 1000);
	expect(Date.parse(cursor ?? '')).toBeLessThanOrEqual(after - expected + 1000);
});

test.each([{ months: '0' }, { months: '2' }, { months: '25' }, { months: 'x' }, { months: '' }])(
	'analyze history rejects months "$months" with 400 and changes nothing',
	async ({ months }) => {
		await seedChannel('UC1');
		await testDb().db.update(channels).set({ cursor: '2026-07-30T00:00:00.000Z' }).where(eq(channels.id, 'UC1'));

		const res = await analyzeHistory('UC1', months);

		expect(res).toMatchObject({ status: 400 });
		expect((await scanWindowOf('UC1')).cursor).toBe('2026-07-30T00:00:00.000Z');
	}
);

test('analyze history rejects an unknown channel with 404', async () => {
	const res = await analyzeHistory('UC-missing', '3');

	expect(res).toMatchObject({ status: 404 });
});

test('analyze history rejects a channel owned by another team with 404 and changes nothing', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');
	await testDb().db.update(channels).set({ cursor: '2026-07-30T00:00:00.000Z' }).where(eq(channels.id, 'UC1'));

	const res = await analyzeHistory('UC1', '3');

	expect(res).toMatchObject({ status: 404 });
	expect((await scanWindowOf('UC1')).cursor).toBe('2026-07-30T00:00:00.000Z');
});

test('analyze history rejects a signed-out request with 401', async () => {
	await seedChannel('UC1');

	await expect(analyzeHistory('UC1', '3', null)).rejects.toMatchObject({ status: 401 });
});
