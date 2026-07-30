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

test('dashboard load never serializes the encrypted refresh token', async () => {
	await testDb().db.insert(channels).values({
		id: 'UC1',
		title: 'One',
		refreshTokenEnc: 'encrypted-refresh-token',
		cursor: '2026-01-01T00:00:00Z'
	});

	const data = await load();

	expect(data.chs).toHaveLength(1);
	expect(data.chs[0]).toMatchObject({ id: 'UC1', title: 'One', cursor: '2026-01-01T00:00:00Z' });
	expect(data.chs[0]).not.toHaveProperty('refreshTokenEnc');
	expect(JSON.stringify(data)).not.toContain('encrypted-refresh-token');
});
