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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { expect, test } from 'vitest';
// testdb must import before anything that pulls in $lib/server/db — its
// vi.mock registers when the module evaluates, and earlier-evaluated modules
// keep the real db.
import { TEST_OWNER, seedConsent, seedUser, setupTestDb, testDb } from '$lib/server/testdb';
import { memberships, organizations } from '$lib/server/db/schema';
import { LEGAL_VERSION } from '$lib/server/legal';
import { SESSION_COOKIE } from '$lib/server/session';
import { makeCookies } from '$lib/server/testcookies';

import { load } from './+layout.server';

setupTestDb(['consents', 'memberships', 'organizations', 'users']);

async function seedOwnerOrg() {
	await seedUser(TEST_OWNER.id);
	await testDb()
		.db.insert(organizations)
		.values({ id: TEST_OWNER.orgId, name: 'One', personalFor: TEST_OWNER.id });
	await testDb()
		.db.insert(memberships)
		.values({ userId: TEST_OWNER.id, orgId: TEST_OWNER.orgId, role: 'owner' });
}

async function captureLoad(user: typeof TEST_OWNER | null, dbDown = false, cookies = makeCookies()) {
	try {
		return await load({ locals: { user, dbDown }, cookies } as never);
	} catch (e) {
		return e as { status: number; location?: string };
	}
}

test('a signed-in user with no consent row is sent to /consent before any app page', async () => {
	await seedOwnerOrg();
	const res = await captureLoad(TEST_OWNER);
	expect(res).toMatchObject({ status: 302, location: '/consent' });
});

test('a signed-in user whose consent predates the current LEGAL_VERSION is sent to /consent', async () => {
	await seedOwnerOrg();
	await seedConsent(TEST_OWNER.id, undefined, '1.0'); // stale doc version
	const res = await captureLoad(TEST_OWNER);
	expect(res).toMatchObject({ status: 302, location: '/consent' });
});

test('a signed-in user with a current consent row loads normally', async () => {
	await seedOwnerOrg();
	await seedConsent(TEST_OWNER.id, undefined, LEGAL_VERSION);
	const data = (await captureLoad(TEST_OWNER)) as {
		orgs: unknown[];
		maintenance: boolean;
		user: unknown;
	};
	expect(data.orgs).toHaveLength(1);
	expect(data.maintenance).toBe(false);
	expect(data.user).toMatchObject({ id: TEST_OWNER.id });
});

test('a signed-out visitor is still redirected to /login', async () => {
	const res = await captureLoad(null);
	expect(res).toMatchObject({ status: 302, location: '/login' });
});

test('a database outage returns the maintenance payload instead of redirecting to /login', async () => {
	// dbDown WITH a session cookie is a signed-in user whose session lookup
	// failed in hooks, so identity is unknown — but bouncing to /login would
	// look like a logout. The maintenance shell is the honest state.
	const cookies = makeCookies();
	cookies.set(SESSION_COOKIE, 'token', { path: '/' });
	const data = (await captureLoad(null, true, cookies)) as {
		maintenance: boolean;
		orgs: unknown[];
	};
	expect(data.maintenance).toBe(true);
	expect(data.orgs).toEqual([]);
});

test('a database outage without a session cookie still redirects to /login', async () => {
	// No cookie means a signed-out visitor: there is no session to protect and
	// the /login redirect costs no database query, so the auth gate must not be
	// bypassed by the outage path.
	const res = await captureLoad(null, true);
	expect(res).toMatchObject({ status: 302, location: '/login' });
});

test('a database outage with a verified user short-circuits before the consent query', async () => {
	// No consent row seeded: reaching hasCurrentConsent would not redirect but
	// the maintenance path must skip it entirely and return the payload.
	const cookies = makeCookies();
	cookies.set(SESSION_COOKIE, 'token', { path: '/' });
	const data = (await captureLoad(TEST_OWNER, true, cookies)) as {
		maintenance: boolean;
		user: unknown;
		orgs: unknown[];
	};
	expect(data.maintenance).toBe(true);
	expect(data.user).toMatchObject({ id: TEST_OWNER.id });
	expect(data.orgs).toEqual([]);
});
