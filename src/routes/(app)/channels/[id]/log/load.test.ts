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

setupTestDb(['audit_log', 'channels']);

const OWNER = { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' };

test('load projects only the channel fields the page renders — never the credential', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, title: 'Ch', refreshTokenEnc: 'enc-secret' });

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);

	expect(result?.ch).toEqual({ id: 'UC1', title: 'Ch' });
	expect(result?.ch).not.toHaveProperty('refreshTokenEnc');
});

test('load on a channel owned by another user fails with 404', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: 'user-2', title: 'Ch', refreshTokenEnc: 'enc-secret' });

	await expect(load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never)).rejects.toMatchObject({ status: 404 });
});

test('load rejects a signed-out request with 401', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, title: 'Ch', refreshTokenEnc: 'enc-secret' });

	await expect(load({ params: { id: 'UC1' }, locals: { user: null } } as never)).rejects.toMatchObject({ status: 401 });
});
