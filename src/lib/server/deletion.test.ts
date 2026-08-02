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

import { DAY_MS, seedConsent, setupTestDb, testDb } from './testdb';
import { auditLog, channels, comments, consents, moderationActions, rules, sessions, users } from './db/schema';
import {
	CONSENT_EMAIL_RETENTION_MS,
	consentEmailCutoffIso,
	deleteUserRecords,
	nullExpiredConsentEmails
} from './deletion';

setupTestDb(['moderation_actions', 'comments', 'audit_log', 'rules', 'channels', 'sessions', 'consents', 'users']);

async function seedUser(id: string) {
	await testDb()
		.db.insert(users)
		.values({ id, googleSub: `sub-${id}`, email: `${id}@example.com`, displayName: id });
	await testDb()
		.db.insert(channels)
		.values({ id: `UC-${id}`, userId: id, title: `channel ${id}`, refreshTokenEnc: 'enc' });
	await testDb()
		.db.insert(sessions)
		.values({ id: `token-${id}`, userId: id, expiresAt: new Date(Date.now() + DAY_MS).toISOString() });
	await testDb().db.insert(comments).values({
		id: `comment-${id}`,
		channelId: `UC-${id}`,
		text: 'hi',
		publishedAt: '2026-01-01T00:00:00.000Z',
		status: 'approved',
		decidedBy: 'ai'
	});
	await testDb().db.insert(moderationActions).values({
		commentId: `comment-${id}`,
		channelId: `UC-${id}`,
		action: 'delete',
		reason: 'test',
		state: 'completed'
	});
	await testDb()
		.db.insert(auditLog)
		.values({ channelId: `UC-${id}`, commentId: `comment-${id}`, action: 'delete', reason: 'test', actor: 'system' });
	await testDb()
		.db.insert(rules)
		.values({ channelId: `UC-${id}`, type: 'keyword', pattern: 'spam', action: 'delete' });
	return id;
}

async function userRow(id: string) {
	return await testDb().db.select().from(users).where(eq(users.id, id)).get();
}

test('deleteUserRecords erases every owned record and tombstones the user fully', async () => {
	const userId = await seedUser('gone');
	await seedConsent(userId);

	await deleteUserRecords(userId);

	expect(await testDb().db.select().from(channels).all()).toEqual([]);
	expect(await testDb().db.select().from(sessions).all()).toEqual([]);
	expect(await testDb().db.select().from(comments).all()).toEqual([]);
	expect(await testDb().db.select().from(moderationActions).all()).toEqual([]);
	expect(await testDb().db.select().from(auditLog).all()).toEqual([]);
	expect(await testDb().db.select().from(rules).all()).toEqual([]);
	expect(await userRow(userId)).toMatchObject({
		googleSub: `deleted:${userId}`,
		email: '[deleted]',
		displayName: '[deleted]'
	});
	// Statutory retention: the consent log survives, WITH the e-mail (Art. 16, III).
	const retained = await testDb().db.select().from(consents).all();
	expect(retained).toHaveLength(1);
	expect(retained[0]).toMatchObject({ userId, email: 'gone@example.com' });
});

test('deleteUserRecords leaves other users and their records alone', async () => {
	const userId = await seedUser('gone');
	await seedUser('stays');
	await seedConsent('stays');

	await deleteUserRecords(userId);

	expect(await userRow('stays')).toMatchObject({ googleSub: 'sub-stays', email: 'stays@example.com' });
	expect((await testDb().db.select().from(channels).all()).map((ch) => ch.id)).toEqual(['UC-stays']);
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(1);
	expect(await testDb().db.select().from(consents).all()).toHaveLength(1);
});

test('deleteUserRecords works for a user with no channels', async () => {
	await testDb()
		.db.insert(users)
		.values({ id: 'solo', googleSub: 'sub-solo', email: 'solo@example.com', displayName: 'solo' });

	await deleteUserRecords('solo');

	expect(await userRow('solo')).toMatchObject({ googleSub: 'deleted:solo', email: '[deleted]' });
});

test('the tombstone frees the Google sub for a fresh signup', async () => {
	const userId = await seedUser('gone');
	await deleteUserRecords(userId);

	await testDb()
		.db.insert(users)
		.values({ id: 'new-user', googleSub: 'sub-gone', email: 'gone@example.com', displayName: 'gone again' });

	expect(await userRow('new-user')).toMatchObject({ googleSub: 'sub-gone' });
});

test('deleteUserRecords rejects re-deleting an already tombstoned user', async () => {
	const userId = await seedUser('gone');
	await seedConsent(userId);

	await deleteUserRecords(userId);

	await expect(deleteUserRecords(userId)).rejects.toThrow(`deleteUserRecords: user ${userId} not found or already deleted`);

	// The rejected second call must leave the tombstone and consent log untouched.
	expect(await userRow(userId)).toMatchObject({ googleSub: `deleted:${userId}` });
	expect(await testDb().db.select().from(users).all()).toHaveLength(1);
	const retained = await testDb().db.select().from(consents).all();
	expect(retained).toHaveLength(1);
	expect(retained[0]).toMatchObject({ userId, email: 'gone@example.com' });
});

test('deleteUserRecords rejects a nonexistent user id', async () => {
	await expect(deleteUserRecords('no-such-user')).rejects.toThrow(
		'deleteUserRecords: user no-such-user not found or already deleted'
	);
	expect(await testDb().db.select().from(users).all()).toEqual([]);
});

test('nullExpiredConsentEmails erases only the e-mail of consents older than 10 years', async () => {
	await seedUser('old');
	const oldDate = new Date(Date.now() - CONSENT_EMAIL_RETENTION_MS - DAY_MS).toISOString();
	const recentDate = new Date(Date.now() - 30 * DAY_MS).toISOString();
	await seedConsent('old', oldDate);
	await seedConsent('old', recentDate);

	expect(await nullExpiredConsentEmails()).toBe(1);

	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toHaveLength(2);
	const old = rows.find((row) => row.createdAt === oldDate);
	const recent = rows.find((row) => row.createdAt === recentDate);
	// The ROW is kept as anonymized evidence; only the identifier is erased.
	expect(old).toMatchObject({ email: null, docVersion: 'v1.2', checkboxText: 'I agree' });
	expect(recent).toMatchObject({ email: 'old@example.com' });
});

test('nullExpiredConsentEmails is idempotent and returns 0 with nothing to do', async () => {
	await seedUser('recent');
	await seedConsent('recent');

	expect(await nullExpiredConsentEmails()).toBe(0);
	expect(await nullExpiredConsentEmails()).toBe(0);
});

test('consentEmailCutoffIso lands 10 years back', () => {
	const now = Date.now();
	expect(Date.parse(consentEmailCutoffIso(now))).toBe(now - CONSENT_EMAIL_RETENTION_MS);
});
