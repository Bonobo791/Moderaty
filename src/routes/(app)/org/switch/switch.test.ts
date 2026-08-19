// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
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

test('a misconfigured production APP_URL fails the switch WITHOUT destroying the old session', async () => {
	// cookieSecure() throws on http APP_URL in production. It must run BEFORE
	// the rotation, so a misconfigured deploy can never delete the user's
	// working token and then fail to issue the replacement (signed-out).
	await seedTwoOrgs();
	await testDb().db.insert(memberships).values({ userId: TEST_OWNER.id, orgId: 'org-2', role: 'member' });
	mocks.env.APP_URL = 'http://moderaty.example';
	mocks.env.CONTEXT = 'production';
	try {
		await expect(call({ orgId: 'org-2' })).rejects.toMatchObject({ status: 500 });
		// The old session is untouched — the user is still signed in.
		expect(await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get()).toBeDefined();
	} finally {
		mocks.env.APP_URL = 'http://localhost:5173';
		delete mocks.env.CONTEXT;
	}
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
