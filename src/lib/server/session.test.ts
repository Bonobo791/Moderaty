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
import { memberships, organizations, sessions, users } from './db/schema';
import { createSession, destroySession, getSessionUser, SESSION_TTL_MS } from './session';

setupTestDb(['sessions', 'memberships', 'organizations', 'users']);

async function seedUser(id = 'user-1') {
	await testDb().db.insert(users).values({ id, googleSub: `sub-${id}`, email: `${id}@example.com`, displayName: id });
	// Every surviving user has a personal org + owner membership (Phase A backfill shape).
	await testDb().db.insert(organizations).values({ id: `org-${id}`, name: id, personalFor: id });
	await testDb().db.insert(memberships).values({ userId: id, orgId: `org-${id}`, role: 'owner' });
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

test('a session with an unreadable expiry is treated as expired, not valid forever', async () => {
	// Mutation audit: without the Number.isNaN guard, NaN comparisons (always
	// false) let a corrupt-expiry session resolve as valid, never renewed,
	// never purged — fail-open on data corruption.
	const userId = await seedUser();
	await testDb().db.insert(sessions).values({ id: 'corrupt-token', userId, expiresAt: 'not-a-date' });

	expect(await getSessionUser('corrupt-token')).toBeNull();
	expect(await testDb().db.select().from(sessions).all()).toEqual([]);
});

test('sliding renewal updates only the resolving session, never another user\'s', async () => {
	// Mutation audit: dropping the WHERE from the renewal UPDATE stayed green
	// because every test seeds exactly one session row — unscoped, one user's
	// renewal would slide EVERY session's expiry (cross-tenant).
	const userId = await seedUser();
	await seedUser('user-2');
	const soonExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // in the renewal window
	const bystanderExpiry = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(); // outside it
	await testDb().db.insert(sessions).values({ id: 'aging-token', userId, expiresAt: soonExpiry });
	await testDb().db.insert(sessions).values({
		id: 'bystander-token',
		userId: 'user-2',
		expiresAt: bystanderExpiry,
		activeOrgId: 'org-user-2'
	});

	const result = await getSessionUser('aging-token');
	expect(result?.renewed).toBe(true);

	const bystander = await testDb().db.select().from(sessions).where(eq(sessions.id, 'bystander-token')).get();
	expect(bystander).toMatchObject({ expiresAt: bystanderExpiry, activeOrgId: 'org-user-2' });
});

test('org repair updates only the resolving session, never another user\'s', async () => {
	// Same mutant class as the renewal test, on the org-repair UPDATE: one
	// user's fallback repair must not rewrite every session's active org.
	const userId = await seedUser();
	await seedUser('user-2');
	await testDb().db.insert(organizations).values({ id: 'org-newer', name: 'Newer Team' });
	await testDb().db.insert(memberships).values({
		userId,
		orgId: 'org-newer',
		role: 'member',
		createdAt: new Date(Date.now() + 60_000).toISOString()
	});
	const { token } = await createSession(userId, undefined, 'org-newer');
	// The user leaves the session's active org, forcing the repair path.
	await testDb().db.delete(memberships).where(eq(memberships.orgId, 'org-newer'));
	const bystanderExpiry = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
	await testDb().db.insert(sessions).values({
		id: 'bystander-token',
		userId: 'user-2',
		expiresAt: bystanderExpiry,
		activeOrgId: 'org-user-2'
	});

	const result = await getSessionUser(token);
	expect(result?.user.orgId).toBe('org-user-1');

	const bystander = await testDb().db.select().from(sessions).where(eq(sessions.id, 'bystander-token')).get();
	expect(bystander).toMatchObject({ expiresAt: bystanderExpiry, activeOrgId: 'org-user-2' });
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

test('a session whose user was deleted after creation resolves null and its row is destroyed', async () => {
	// Regression: a login callback can read the user before the deleteAccount
	// transaction commits and create a session after it deleted every session.
	// That orphaned session must never grant access to the deleted account
	// (tombstone marker: googleSub = 'deleted:<id>').
	const userId = await seedUser();
	const { token } = await createSession(userId);
	await testDb()
		.db.update(users)
		.set({ googleSub: `deleted:${userId}`, email: '[deleted]', displayName: '[deleted]' })
		.where(eq(users.id, userId));

	expect(await getSessionUser(token)).toBeNull();
	expect(await testDb().db.select().from(sessions).all()).toEqual([]);
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

test('a session with active_org_id set resolves that org id/name/role/plan onto the user', async () => {
	const userId = await seedUser();
	// Plan comes from the ORGANIZATION, never the legacy users.plan.
	await testDb().db.update(organizations).set({ plan: 'pro' }).where(eq(organizations.id, 'org-user-1'));

	const { token } = await createSession(userId, undefined, 'org-user-1');
	const result = await getSessionUser(token);

	expect(result).toMatchObject({
		user: { id: userId, plan: 'pro', orgId: 'org-user-1', orgName: 'user-1', orgRole: 'owner' }
	});
});

test('a session with active_org_id NULL resolves the oldest membership', async () => {
	const userId = await seedUser(); // personal org membership: created now
	await testDb().db.insert(organizations).values({ id: 'org-newer', name: 'Newer Team' });
	await testDb().db.insert(memberships).values({
		userId,
		orgId: 'org-newer',
		role: 'member',
		createdAt: new Date(Date.now() + 60_000).toISOString() // strictly newer
	});

	const { token } = await createSession(userId); // activeOrgId null
	const result = await getSessionUser(token);

	expect(result?.user.orgId).toBe('org-user-1');
	expect(result?.user.orgRole).toBe('owner');
});

test('a session whose active org membership vanished falls back to the oldest membership and is repaired', async () => {
	const userId = await seedUser();
	await testDb().db.insert(organizations).values({ id: 'org-newer', name: 'Newer Team' });
	await testDb().db.insert(memberships).values({
		userId,
		orgId: 'org-newer',
		role: 'member',
		createdAt: new Date(Date.now() + 60_000).toISOString()
	});
	const { token } = await createSession(userId, undefined, 'org-newer');
	// The user leaves (or is removed from) the session's active org.
	await testDb().db.delete(memberships).where(eq(memberships.orgId, 'org-newer'));

	const result = await getSessionUser(token);

	expect(result?.user.orgId).toBe('org-user-1');
	const repaired = await testDb().db.select().from(sessions).where(eq(sessions.id, token)).get();
	expect(repaired?.activeOrgId).toBe('org-user-1');
});

test('a user with zero memberships makes getSessionUser throw, never sign out', async () => {
	// Zero memberships is a data bug (Phase A backfill guarantees one) — fail
	// loudly rather than improvise access or read as signed-out.
	await testDb()
		.db.insert(users)
		.values({ id: 'bare', googleSub: 'sub-bare', email: 'bare@example.com', displayName: 'bare' });
	const { token } = await createSession('bare');

	await expect(getSessionUser(token)).rejects.toThrow('account has no organization');
});
