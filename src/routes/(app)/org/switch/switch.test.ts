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

// testdb must be the first app import: it registers the $lib/server/db mock,
// and any module that loads the real db first (session.ts, the route) would
// otherwise bind the REAL database — testdb.ts's header documents this.
import { postForm, setupTestDb, TEST_OWNER, testDb } from '$lib/server/testdb';
import { memberships, organizations, sessions, users } from '$lib/server/db/schema';
import { SESSION_COOKIE } from '$lib/server/session';
import { makeCookies } from '$lib/server/testcookies';

import { POST } from './+server';

setupTestDb(['sessions', 'memberships', 'organizations', 'users']);

async function seedTwoOrgs() {
	await testDb()
		.db.insert(users)
		.values({ id: TEST_OWNER.id, googleSub: 'sub-user-1', email: TEST_OWNER.email, displayName: TEST_OWNER.displayName });
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'One' });
	await testDb().db.insert(organizations).values({ id: 'org-2', name: 'Two' });
	await testDb().db.insert(memberships).values({ userId: TEST_OWNER.id, orgId: 'org-1', role: 'owner' });
	await testDb()
		.db.insert(sessions)
		.values({ id: 'sess-1', userId: TEST_OWNER.id, activeOrgId: 'org-1', expiresAt: '2099-01-01T00:00:00.000Z' });
}

function call(fields: Record<string, string>, opts: { signedIn?: boolean; cookie?: boolean } = {}) {
	const cookies = makeCookies();
	if (opts.cookie !== false) cookies.set(SESSION_COOKIE, 'sess-1', { path: '/' });
	return POST({
		request: postForm(fields, 'http://localhost/org/switch'),
		locals: { user: opts.signedIn === false ? null : TEST_OWNER },
		cookies
	} as never);
}

test('rejects signed-out callers and missing session cookies with 401', async () => {
	await seedTwoOrgs();
	await expect(call({ orgId: 'org-1' }, { signedIn: false })).rejects.toMatchObject({
		status: 401,
		body: { message: 'sign-in required' }
	});
	await expect(call({ orgId: 'org-1' }, { cookie: false })).rejects.toMatchObject({
		status: 401,
		body: { message: 'sign-in required' }
	});
});

test('rejects a missing orgId with 400', async () => {
	await seedTwoOrgs();
	await expect(call({})).rejects.toMatchObject({ status: 400, body: { message: 'missing team' } });
});

test('switching to an org the user does not belong to is 404', async () => {
	await seedTwoOrgs();
	await expect(call({ orgId: 'org-2' })).rejects.toMatchObject({ status: 404 });
	const sess = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get();
	expect(sess?.activeOrgId).toBe('org-1'); // untouched
});

test('a member switch rotates the session: the old token dies, a new cookie lands at the new org, 303 to dashboard', async () => {
	await seedTwoOrgs();
	await testDb().db.insert(memberships).values({ userId: TEST_OWNER.id, orgId: 'org-2', role: 'member' });

	await expect(call({ orgId: 'org-2' })).rejects.toMatchObject({ status: 303, location: '/dashboard' });
	// Rotation: the pre-switch token can never resolve again; the replacement
	// row carries the new org, and the response issues the new cookie.
	expect(await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get()).toBeUndefined();
	const rows = await testDb().db.select().from(sessions).where(eq(sessions.userId, TEST_OWNER.id)).all();
	expect(rows).toHaveLength(1);
	expect(rows[0].activeOrgId).toBe('org-2');
});

test('the switch response writes the rotated session cookie (httpOnly, secure per APP_URL)', async () => {
	await seedTwoOrgs();
	await testDb().db.insert(memberships).values({ userId: TEST_OWNER.id, orgId: 'org-2', role: 'member' });
	const cookies = makeCookies();
	cookies.set(SESSION_COOKIE, 'sess-1', { path: '/' });

	await expect(
		POST({
			request: postForm({ orgId: 'org-2' }, 'http://localhost/org/switch'),
			locals: { user: TEST_OWNER },
			cookies
		} as never)
	).rejects.toMatchObject({ status: 303, location: '/dashboard' });

	const set = cookies.setCalls.filter((c) => c.name === SESSION_COOKIE).at(-1);
	expect(set).toBeDefined();
	expect(set!.value).toMatch(/^[0-9a-f]{64}$/);
	expect(set!.opts).toMatchObject({ path: '/', httpOnly: true, sameSite: 'lax' });
	const newRow = await testDb().db.select().from(sessions).where(eq(sessions.id, set!.value)).get();
	expect(newRow).toMatchObject({ userId: TEST_OWNER.id, activeOrgId: 'org-2' });
});
