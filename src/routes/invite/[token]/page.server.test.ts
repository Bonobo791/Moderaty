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
import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {
		APP_URL: 'http://localhost:5173'
	} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

// testdb must be the first app import: it registers the $lib/server/db mock
// before any module that binds the real database (see its header comment).
import { setupTestDb, TEST_OWNER, testDb } from '$lib/server/testdb';
import { invites, memberships, organizations, sessions, users } from '$lib/server/db/schema';
import { SESSION_COOKIE } from '$lib/server/session';
import { makeCookies } from '$lib/server/testcookies';

import { actions, load } from './+page.server';

setupTestDb(['sessions', 'invites', 'memberships', 'organizations', 'users']);

async function seedOrgWithInvite(token: string, overrides: { expiresAt?: string; acceptedBy?: string | null } = {}) {
	await testDb()
		.db.insert(users)
		.values({ id: 'owner-9', googleSub: 'sub-owner-9', email: 'owner-9@example.com', displayName: 'owner-9' });
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Team One' });
	await testDb().db.insert(memberships).values({ userId: 'owner-9', orgId: 'org-1', role: 'owner' });
	await testDb()
		.db.insert(invites)
		.values({
			token,
			orgId: 'org-1',
			role: 'member',
			createdBy: 'owner-9',
			expiresAt: overrides.expiresAt ?? '2099-01-01T00:00:00.000Z',
			acceptedBy: overrides.acceptedBy ?? null
		});
}

async function seedJoiner() {
	await testDb()
		.db.insert(users)
		.values({ id: TEST_OWNER.id, googleSub: 'sub-user-1', email: TEST_OWNER.email, displayName: TEST_OWNER.displayName });
	await testDb()
		.db.insert(sessions)
		.values({ id: 'sess-1', userId: TEST_OWNER.id, expiresAt: '2099-01-01T00:00:00.000Z' });
}

function loadCtx(token: string, signedIn = true) {
	return { params: { token }, locals: { user: signedIn ? TEST_OWNER : null } } as never;
}

function acceptCtx(token: string, opts: { signedIn?: boolean; cookie?: boolean } = {}) {
	const cookies = makeCookies();
	if (opts.cookie !== false) cookies.set(SESSION_COOKIE, 'sess-1', { path: '/' });
	return {
		params: { token },
		locals: { user: opts.signedIn === false ? null : TEST_OWNER },
		cookies
	} as never;
}

test('load: unknown token is a plain 404', async () => {
	await expect(load(loadCtx('tok-nope'))).rejects.toMatchObject({ status: 404, body: { message: 'invite not found' } });
});

test('load: known token returns the preview and the signed-in flag', async () => {
	await seedOrgWithInvite('tok-1');
	const out = (await load(loadCtx('tok-1', false))) as { invite: { orgName: string; role: string }; signedIn: boolean };
	expect(out.invite).toMatchObject({ orgName: 'Team One', role: 'member', expired: false, accepted: false });
	expect(out.signedIn).toBe(false);
	expect(((await load(loadCtx('tok-1'))) as { signedIn: boolean }).signedIn).toBe(true);
});

test('accept: signed-out is 401, missing session cookie is 401', async () => {
	await seedOrgWithInvite('tok-1');
	await expect(actions.default(acceptCtx('tok-1', { signedIn: false }))).rejects.toMatchObject({
		status: 401,
		body: { message: 'sign-in required' }
	});
	await expect(actions.default(acceptCtx('tok-1', { cookie: false }))).rejects.toMatchObject({
		status: 401,
		body: { message: 'sign-in required' }
	});
});

test('accept: joins the org, burns the token, 303s to the dashboard; reuse is 410', async () => {
	await seedOrgWithInvite('tok-1');
	await seedJoiner();

	await expect(actions.default(acceptCtx('tok-1'))).rejects.toMatchObject({ status: 303, location: '/dashboard' });
	const joined = await testDb().db.select().from(memberships).where(eq(memberships.userId, TEST_OWNER.id)).all();
	expect(joined).toHaveLength(1);
	expect(joined[0]).toMatchObject({ orgId: 'org-1', role: 'member' });
	const burned = await testDb().db.select().from(invites).where(eq(invites.token, 'tok-1')).get();
	expect(burned?.acceptedBy).toBe(TEST_OWNER.id);

	// Reopening the link after accepting: the load flags it, a POST is 410.
	const preview = (await load(loadCtx('tok-1'))) as { invite: { accepted: boolean } };
	expect(preview.invite.accepted).toBe(true);
	await expect(actions.default(acceptCtx('tok-1'))).rejects.toMatchObject({ status: 410 });
});

test('accept: the session lands in the joined org (rotated: the old token dies, a fresh cookie is issued)', async () => {
	// PR #52 review — untested assertion, now rotation: the pre-accept token
	// must die so it can never resolve at the joined org.
	await seedOrgWithInvite('tok-1');
	await seedJoiner();
	const cookies = makeCookies();
	cookies.set(SESSION_COOKIE, 'sess-1', { path: '/' });

	await expect(
		actions.default({ params: { token: 'tok-1' }, locals: { user: TEST_OWNER }, cookies } as never)
	).rejects.toMatchObject({ status: 303, location: '/dashboard' });

	expect(await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get()).toBeUndefined();
	const set = cookies.setCalls.filter((c) => c.name === SESSION_COOKIE).at(-1);
	expect(set).toBeDefined();
	expect(set!.value).toMatch(/^[0-9a-f]{64}$/);
	const newRow = await testDb().db.select().from(sessions).where(eq(sessions.id, set!.value)).get();
	expect(newRow).toMatchObject({ userId: TEST_OWNER.id, activeOrgId: 'org-1' });
});
