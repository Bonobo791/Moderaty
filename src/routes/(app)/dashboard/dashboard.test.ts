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
import { setupTestDb, testDb } from '$lib/server/testdb';
import { channels } from '$lib/server/db/schema';

import { load } from './+page.server';

setupTestDb(['comments', 'channels']);

const OWNER = { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' };

function loadDashboard(user: typeof OWNER | null = OWNER) {
	return load({ locals: { user } } as never);
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
