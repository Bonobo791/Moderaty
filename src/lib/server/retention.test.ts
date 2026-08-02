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

import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';

import { setupTestDb, testDb } from './testdb';
import { channels, sessions, users } from './db/schema';
import { isRetentionExpired, purgeExpiredUser, purgeUserById, retentionCutoffIso } from './retention';

setupTestDb(['moderation_actions', 'comments', 'audit_log', 'rules', 'channels', 'sessions', 'users']);

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedUser(id: string, deletedAt: string | null) {
	await testDb().db.insert(users).values({
		id,
		googleSub: `sub-${id}`,
		email: `${id}@example.com`,
		displayName: id,
		deletedAt
	});
	await testDb().db.insert(channels).values({
		id: `UC-${id}`,
		userId: id,
		title: `channel ${id}`,
		refreshTokenEnc: 'enc',
		active: 0
	});
	await testDb().db.insert(sessions).values({
		id: `token-${id}`,
		userId: id,
		expiresAt: new Date(Date.now() + DAY_MS).toISOString()
	});
	return id;
}

async function userRow(id: string) {
	return await testDb().db.select().from(users).where(eq(users.id, id)).get();
}

test('purges an expired soft-deleted user: owned rows removed, tombstone anonymized', async () => {
	const expiredAt = new Date(Date.now() - 181 * DAY_MS).toISOString();
	const userId = await seedUser('purge-me', expiredAt);

	const purged = await purgeUserById(userId, expiredAt);

	expect(purged).toBe(true);
	expect(await testDb().db.select().from(channels).all()).toEqual([]);
	expect(await testDb().db.select().from(sessions).all()).toEqual([]);
	expect(await userRow(userId)).toMatchObject({
		googleSub: `deleted:${userId}`,
		email: '[deleted]',
		displayName: '[deleted]',
		deletedAt: null
	});
});

test('race: skips the purge when the account was restored after selection', async () => {
	// purgeExpiredUser selected this user at `selectedAt`; before the purge
	// transaction starts, the login callback restores the account.
	const selectedAt = new Date(Date.now() - 181 * DAY_MS).toISOString();
	const userId = await seedUser('restored', selectedAt);
	await testDb().db.update(users).set({ deletedAt: null }).where(eq(users.id, userId));

	const purged = await purgeUserById(userId, selectedAt);

	expect(purged).toBe(false);
	expect(await userRow(userId)).toMatchObject({
		googleSub: 'sub-restored',
		email: 'restored@example.com',
		deletedAt: null
	});
	expect(await testDb().db.select().from(channels).all()).toHaveLength(1);
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(1);
});

test('race: skips the purge when the deletion marker changed after selection', async () => {
	// The account was restored and deleted again — the new deleted_at is NOT
	// the expired timestamp the selection saw, so purging on it is wrong.
	const selectedAt = new Date(Date.now() - 181 * DAY_MS).toISOString();
	const userId = await seedUser('re-deleted', new Date().toISOString());

	const purged = await purgeUserById(userId, selectedAt);

	expect(purged).toBe(false);
	expect(await userRow(userId)).toMatchObject({ googleSub: 'sub-re-deleted', email: 're-deleted@example.com' });
	expect(await testDb().db.select().from(channels).all()).toHaveLength(1);
});

test('purgeExpiredUser purges only the oldest expired user and leaves the rest alone', async () => {
	const older = await seedUser('older', new Date(Date.now() - 200 * DAY_MS).toISOString());
	const newer = await seedUser('newer', new Date(Date.now() - 190 * DAY_MS).toISOString());
	const withinWindow = await seedUser('within', new Date(Date.now() - 10 * DAY_MS).toISOString());
	await seedUser('active', null);

	expect(await purgeExpiredUser()).toBe(older);
	expect(await userRow(older)).toMatchObject({ googleSub: `deleted:${older}` });
	// The next-oldest expired user drains on a later run (bounded runs, I10).
	expect(await userRow(newer)).toMatchObject({ googleSub: 'sub-newer' });
	expect(await userRow(withinWindow)).toMatchObject({ googleSub: 'sub-within' });
	expect(await userRow('active')).toMatchObject({ googleSub: 'sub-active' });
});

test('purgeExpiredUser returns null when no user is past the retention window', async () => {
	await seedUser('within', new Date(Date.now() - 10 * DAY_MS).toISOString());
	await seedUser('active', null);

	expect(await purgeExpiredUser()).toBeNull();
});

test('retention helpers agree on the boundary', async () => {
	expect(isRetentionExpired(new Date(Date.now() - 181 * DAY_MS).toISOString())).toBe(true);
	expect(isRetentionExpired(new Date(Date.now() - 10 * DAY_MS).toISOString())).toBe(false);
	expect(retentionCutoffIso(Date.now())).toBe(new Date(Date.now() - 180 * DAY_MS).toISOString());
});
