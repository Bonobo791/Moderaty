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
// testdb must import before anything that pulls in $lib/server/db — its
// vi.mock registers when the module evaluates, and earlier-evaluated modules
// keep the real db.
import { TEST_OWNER, seedConsent, seedUser, setupTestDb, testDb } from '$lib/server/testdb';
import { memberships, organizations } from '$lib/server/db/schema';
import { LEGAL_VERSION } from '$lib/server/legal';

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

async function captureLoad(user: typeof TEST_OWNER | null) {
	try {
		return await load({ locals: { user } } as never);
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
	const data = (await captureLoad(TEST_OWNER)) as { orgs: unknown[] };
	expect(data.orgs).toHaveLength(1);
});

test('a signed-out visitor is still redirected to /login', async () => {
	const res = await captureLoad(null);
	expect(res).toMatchObject({ status: 302, location: '/login' });
});
