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

import { setupTestDb, testDb } from './testdb';
import { sessions, users } from './db/schema';
import { createSession, destroySession, getSessionUser, SESSION_TTL_MS } from './session';

setupTestDb(['sessions', 'users']);

async function seedUser(id = 'user-1') {
	await testDb().db.insert(users).values({ id, googleSub: `sub-${id}`, email: `${id}@example.com`, displayName: id });
	return id;
}

test('creates a session and resolves it back to the user', async () => {
	const userId = await seedUser();

	const { token, expiresAt } = await createSession(userId);
	const result = await getSessionUser(token);

	expect(token).toMatch(/^[0-9a-f]{64}$/);
	expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
	expect(result).toMatchObject({ renewed: false, user: { id: userId, email: 'user-1@example.com' } });
});

test('returns null for an unknown or malformed token', async () => {
	expect(await getSessionUser('no-such-token')).toBeNull();
	expect(await getSessionUser(undefined)).toBeNull();
	expect(await getSessionUser('')).toBeNull();
});

test('expires sessions lazily: an expired token resolves null and its row is deleted', async () => {
	const userId = await seedUser();
	await testDb().db.insert(sessions).values({
		id: 'expired-token',
		userId,
		expiresAt: new Date(Date.now() - 1000).toISOString()
	});

	expect(await getSessionUser('expired-token')).toBeNull();
	expect(await testDb().db.select().from(sessions).all()).toEqual([]);
});

test('renews a session sliding into its last 15 days', async () => {
	const userId = await seedUser();
	const soonExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 1 day left
	await testDb().db.insert(sessions).values({ id: 'aging-token', userId, expiresAt: soonExpiry });

	const result = await getSessionUser('aging-token');

	expect(result?.renewed).toBe(true);
	expect(Date.parse(result!.expiresAt)).toBeGreaterThan(Date.parse(soonExpiry));
});

test('destroys a session so it no longer resolves', async () => {
	const userId = await seedUser();
	const { token } = await createSession(userId);

	await destroySession(token);

	expect(await getSessionUser(token)).toBeNull();
});

test('creating a session purges already-expired rows', async () => {
	const userId = await seedUser();
	await testDb().db.insert(sessions).values({
		id: 'stale-token',
		userId,
		expiresAt: new Date(Date.now() - 1000).toISOString()
	});
	await testDb().db.insert(sessions).values({
		id: 'live-token',
		userId,
		expiresAt: new Date(Date.now() + 60_000).toISOString()
	});

	await createSession(userId);

	const ids = (await testDb().db.select().from(sessions).all()).map((s) => s.id);
	expect(ids).not.toContain('stale-token');
	expect(ids).toContain('live-token');
});
