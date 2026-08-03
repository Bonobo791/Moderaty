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

// testdb must be the first app import: it registers the $lib/server/db mock
// before any module that binds the real database (see its header comment).
import { postForm, setupTestDb, TEST_OWNER, testDb } from '$lib/server/testdb';
import { invites, memberships, organizations, sessions, users } from '$lib/server/db/schema';
import { SESSION_COOKIE, type SessionUser } from '$lib/server/session';
import { makeCookies } from '$lib/server/testcookies';

import { actions, load } from './+page.server';

setupTestDb(['sessions', 'invites', 'memberships', 'organizations', 'users']);

const MEMBER: SessionUser = { ...TEST_OWNER, orgRole: 'member' };

async function seedOwnerOrg() {
	await testDb()
		.db.insert(users)
		.values({ id: TEST_OWNER.id, googleSub: 'sub-user-1', email: TEST_OWNER.email, displayName: TEST_OWNER.displayName });
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'One' });
	await testDb().db.insert(memberships).values({ userId: TEST_OWNER.id, orgId: 'org-1', role: 'owner' });
}

/** Adds a second user as a member of org-1 (shares user-1's session fixtures as needed). */
async function seedTeammate(userId: string, role: 'admin' | 'member' = 'member') {
	await testDb()
		.db.insert(users)
		.values({ id: userId, googleSub: `sub-${userId}`, email: `${userId}@example.com`, displayName: userId });
	await testDb().db.insert(memberships).values({ userId, orgId: 'org-1', role });
}

function ctx(user: SessionUser | null, fields: Record<string, string> = {}, withCookie = true) {
	const cookies = makeCookies();
	if (withCookie) cookies.set(SESSION_COOKIE, 'sess-1', { path: '/' });
	return {
		request: postForm(fields, 'http://localhost/org'),
		locals: { user },
		cookies,
		url: new URL('http://localhost/org')
	} as never;
}

function failure(result: unknown): { status: number; data: { error: string } } {
	return result as { status: number; data: { error: string } };
}

test('load: 401 signed out; members get the roster but no invites; admins get open invites', async () => {
	await seedOwnerOrg();
	await seedTeammate('user-2');
	await testDb().db.insert(invites).values({
		token: 'tok-1',
		orgId: 'org-1',
		role: 'member',
		createdBy: TEST_OWNER.id,
		expiresAt: '2099-01-01T00:00:00.000Z'
	});

	await expect(load(ctx(null))).rejects.toMatchObject({ status: 401 });

	const ownerView = (await load(ctx(TEST_OWNER))) as { members: unknown[]; invites: unknown[]; inviteBase: string };
	expect(ownerView.members).toHaveLength(2);
	expect(ownerView.invites).toHaveLength(1);
	expect(ownerView.inviteBase).toBe('http://localhost/invite/');

	const memberView = (await load(ctx(MEMBER))) as { members: unknown[]; invites: unknown[] };
	expect(memberView.members).toHaveLength(2);
	expect(memberView.invites).toEqual([]); // member role never sees invite management
});

test('rename: member is a raw 403; owner errors are wrapped as form failures', async () => {
	await seedOwnerOrg();
	await expect(actions.rename(ctx(MEMBER, { name: 'New' }))).rejects.toMatchObject({ status: 403 });

	const bad = failure(await actions.rename(ctx(TEST_OWNER, { name: '' })));
	expect(bad.status).toBe(400);
	expect(bad.data.error).toContain('1–80');

	await actions.rename(ctx(TEST_OWNER, { name: 'Renamed' }));
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.name).toBe('Renamed');
});

test('createTeam: bad name fails loudly; success creates a shared org the user owns', async () => {
	await seedOwnerOrg();
	const bad = failure(await actions.createTeam(ctx(TEST_OWNER, { name: '   ' })));
	expect(bad.status).toBe(400);

	await actions.createTeam(ctx(TEST_OWNER, { name: 'Second Team' }));
	const mine = await testDb().db.select().from(memberships).where(eq(memberships.userId, TEST_OWNER.id)).all();
	expect(mine).toHaveLength(2);
	const created = mine.find((m) => m.orgId !== 'org-1');
	const newOrg = await testDb().db.select().from(organizations).where(eq(organizations.id, created!.orgId)).get();
	expect(newOrg?.name).toBe('Second Team');
	expect(newOrg?.personalFor).toBeNull();
});

test('invite: member is 403; bad role is a 400 failure; success returns the token', async () => {
	await seedOwnerOrg();
	await expect(actions.invite(ctx(MEMBER, { role: 'member' }))).rejects.toMatchObject({ status: 403 });

	const badRole = failure(await actions.invite(ctx(TEST_OWNER, { role: 'owner' })));
	expect(badRole.status).toBe(400);

	const good = (await actions.invite(ctx(TEST_OWNER, { role: 'admin' }))) as { ok: true; inviteToken: string };
	expect(good.ok).toBe(true);
	const row = await testDb().db.select().from(invites).where(eq(invites.token, good.inviteToken)).get();
	expect(row?.role).toBe('admin');
});

test('revokeInvite: member is 403; unknown token is a wrapped 404', async () => {
	await seedOwnerOrg();
	await expect(actions.revokeInvite(ctx(MEMBER, { token: 'tok-1' }))).rejects.toMatchObject({ status: 403 });
	const gone = failure(await actions.revokeInvite(ctx(TEST_OWNER, { token: 'tok-nope' })));
	expect(gone.status).toBe(404);
});

test('setRole: non-owner is 403; last-owner demotion is a wrapped 400', async () => {
	await seedOwnerOrg();
	const admin: SessionUser = { ...TEST_OWNER, orgRole: 'admin' };
	await expect(actions.setRole(ctx(admin, { userId: 'user-2', role: 'member' }))).rejects.toMatchObject({ status: 403 });

	const demote = failure(await actions.setRole(ctx(TEST_OWNER, { userId: TEST_OWNER.id, role: 'member' })));
	expect(demote.status).toBe(400);
	expect(demote.data.error).toContain('last owner');
});

test('remove: self-removal is a wrapped 400 pointing at Leave team', async () => {
	await seedOwnerOrg();
	const self = failure(await actions.remove(ctx(TEST_OWNER, { userId: TEST_OWNER.id })));
	expect(self.status).toBe(400);
	expect(self.data.error).toContain('Leave team');

	await seedTeammate('user-2');
	await actions.remove(ctx(TEST_OWNER, { userId: 'user-2' }));
	const gone = await testDb()
		.db.select()
		.from(memberships)
		.where(eq(memberships.userId, 'user-2'))
		.all();
	expect(gone).toHaveLength(0);
});

test('leave: missing cookie fails 401; sole member is a wrapped 400', async () => {
	await seedOwnerOrg();
	const noCookie = failure(await actions.leave(ctx(TEST_OWNER, {}, false)));
	expect(noCookie.status).toBe(401);

	const sole = failure(await actions.leave(ctx(TEST_OWNER)));
	expect(sole.status).toBe(400);
	expect(sole.data.error).toContain('only member');
});

test('leave: a successful leave 303s to the dashboard (post-leave /org would 404 on the stale locals)', async () => {
	// PR #52 review (Codacy): locals are frozen for the request, so rendering
	// /org after leaving the active team would re-list members of the team the
	// user just left and 404. Redirect to a fresh request instead.
	await seedOwnerOrg();
	// A second owner in org-1, so leaving is permitted.
	await testDb()
		.db.insert(users)
		.values({ id: 'user-2', googleSub: 'sub-user-2', email: 'user-2@example.com', displayName: 'user-2' });
	await testDb().db.insert(memberships).values({ userId: 'user-2', orgId: 'org-1', role: 'owner' });
	await testDb()
		.db.insert(sessions)
		.values({ id: 'sess-1', userId: TEST_OWNER.id, activeOrgId: 'org-1', expiresAt: '2099-01-01T00:00:00.000Z' });

	await expect(actions.leave(ctx(TEST_OWNER))).rejects.toMatchObject({ status: 303, location: '/dashboard' });
	const gone = await testDb().db.select().from(memberships).where(eq(memberships.userId, TEST_OWNER.id)).all();
	expect(gone).toHaveLength(0);
	const sess = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get();
	expect(sess?.activeOrgId).toBeNull();
});
