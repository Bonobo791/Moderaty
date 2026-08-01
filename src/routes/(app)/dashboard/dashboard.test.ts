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
import { makeCookies } from '$lib/server/testcookies';
import { channels, sessions, users } from '$lib/server/db/schema';

import { actions, load } from './+page.server';

setupTestDb(['comments', 'channels', 'users', 'sessions']);

const OWNER = { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' };

function loadDashboard(user: typeof OWNER | null = OWNER) {
	return load({ locals: { user } } as never);
}

async function seedActiveUser() {
	await testDb().db.insert(users).values({ id: OWNER.id, googleSub: 'sub-1', email: OWNER.email, displayName: OWNER.displayName });
	await testDb().db.insert(sessions).values({ id: 'sess-1', userId: OWNER.id, expiresAt: '2027-01-01T00:00:00.000Z' });
	await testDb().db.insert(channels).values({ id: 'UC1', userId: OWNER.id, title: 'Mine', refreshTokenEnc: 'enc', active: 1 });
}

async function captureDelete(user: typeof OWNER | null, fields: Record<string, string>) {
	const cookies = makeCookies();
	try {
		const res = await actions.deleteAccount({ request: postForm(fields), locals: { user }, cookies } as never);
		return { res, cookies };
	} catch (e) {
		return { res: e as { status: number; location?: string }, cookies };
	}
}

test('dashboard load never serializes the encrypted refresh token', async () => {
	await testDb().db.insert(channels).values({
		id: 'UC1',
		userId: OWNER.id,
		title: 'One',
		refreshTokenEnc: 'encrypted-refresh-token',
		cursor: '2026-01-01T00:00:00Z'
	});

	const data = await loadDashboard();

	expect(data.chs).toHaveLength(1);
	expect(data.chs[0]).toMatchObject({ id: 'UC1', title: 'One', cursor: '2026-01-01T00:00:00Z' });
	expect(data.chs[0]).not.toHaveProperty('refreshTokenEnc');
	expect(JSON.stringify(data)).not.toContain('encrypted-refresh-token');
});

test('dashboard load shows only the signed-in user\'s channels', async () => {
	await testDb().db.insert(channels).values({ id: 'UC1', userId: OWNER.id, title: 'Mine', refreshTokenEnc: 'enc' });
	await testDb().db.insert(channels).values({ id: 'UC2', userId: 'user-2', title: 'Theirs', refreshTokenEnc: 'enc' });

	const data = await loadDashboard();

	expect(data.chs.map((ch) => ch.id)).toEqual(['UC1']);
});

test('dashboard load rejects a signed-out request with 401', async () => {
	await expect(loadDashboard(null)).rejects.toMatchObject({ status: 401 });
});

test('delete account rejects a signed-out request with 401', async () => {
	const { res } = await captureDelete(null, { confirm: 'on' });
	expect(res).toMatchObject({ status: 401 });
});

test('delete account without the confirmation checkbox writes nothing', async () => {
	await seedActiveUser();

	const { res } = await captureDelete(OWNER, {});

	expect(res).toMatchObject({ status: 400 });
	expect((await testDb().db.select().from(users).all())[0].deletedAt).toBeNull();
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(1);
	expect((await testDb().db.select().from(channels).all())[0].active).toBe(1);
});

test('delete account soft-deletes, destroys sessions, deactivates channels, and signs out', async () => {
	await seedActiveUser();

	const { res, cookies } = await captureDelete(OWNER, { confirm: 'on' });

	expect(res).toMatchObject({ status: 302, location: '/' });
	const deleted = await testDb().db.select().from(users).all();
	expect(deleted).toHaveLength(1);
	expect(deleted[0].deletedAt).toBeTruthy();
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(0);
	expect((await testDb().db.select().from(channels).all())[0].active).toBe(0);
	expect(cookies.deleteCalls.some((c) => c.name === 'moderaty_session')).toBe(true);
});
