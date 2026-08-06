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

import { consents, invites, memberships, organizations, users } from './db/schema';
import { seedConsent, seedUser, setupTestDb, testDb, wipeTables } from './testdb';

// Harness self-test (PR #48 review): schema.ts exports the tenant tables from
// Phase A, so createTestDb's hand-written DDL must create them too — every
// Phase B+ fixture seeds orgs/memberships through this helper. Guards the
// table presence AND the constraints the app relies on (personal_for UNIQUE,
// memberships composite PK).
setupTestDb(['consents', 'invites', 'memberships', 'organizations', 'users']);

test('wipeTables empties the given tables on demand (per-property-run freshness)', async () => {
	await seedUser('wipe-me');
	expect(await testDb().db.select().from(users).all()).toHaveLength(1);
	await wipeTables(['users']);
	expect(await testDb().db.select().from(users).all()).toHaveLength(0);
});

test('createTestDb creates the tenant tables', async () => {
	const tables = await testDb().client.execute(
		"SELECT name FROM sqlite_master WHERE name IN ('organizations','memberships','invites') ORDER BY name"
	);
	expect(tables.rows.map((row) => row.name)).toEqual(['invites', 'memberships', 'organizations']);
});

test('tenant round-trip: org + owner membership + invite persist and read back', async () => {
	await seedUser('user-1');
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'One', personalFor: 'user-1' });
	await testDb().db.insert(memberships).values({ userId: 'user-1', orgId: 'org-1', role: 'owner' });
	await testDb().db.insert(invites).values({
		token: 'tok-1',
		orgId: 'org-1',
		role: 'member',
		createdBy: 'user-1',
		expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
	});
	const org = await testDb().db.select().from(organizations).all();
	const mem = await testDb().db.select().from(memberships).all();
	const inv = await testDb().db.select().from(invites).all();
	expect(org).toMatchObject([{ id: 'org-1', name: 'One', plan: 'free', personalFor: 'user-1' }]);
	expect(mem).toMatchObject([{ userId: 'user-1', orgId: 'org-1', role: 'owner' }]);
	expect(inv).toMatchObject([
		{ token: 'tok-1', orgId: 'org-1', role: 'member', createdBy: 'user-1', expiresAt: expect.any(String) }
	]);
});

test('personal_for UNIQUE and memberships composite PK are enforced', async () => {
	await seedUser('user-1');
	await seedUser('user-2');
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'One', personalFor: 'user-1' });
	await testDb().db.insert(organizations).values({ id: 'org-2', name: 'Two', personalFor: 'user-2' });
	await testDb().db.insert(memberships).values({ userId: 'user-1', orgId: 'org-1', role: 'owner' });
	// Positive controls: cross memberships must SUCCEED — a PRIMARY KEY on
	// user_id alone would reject these, so they prove the key is composite.
	await testDb().db.insert(memberships).values({ userId: 'user-1', orgId: 'org-2', role: 'member' });
	await testDb().db.insert(memberships).values({ userId: 'user-2', orgId: 'org-1', role: 'member' });
	await expect(
		testDb().db.insert(organizations).values({ id: 'org-3', name: 'Dup', personalFor: 'user-1' })
	).rejects.toThrow();
	await expect(
		testDb().db.insert(memberships).values({ userId: 'user-1', orgId: 'org-1', role: 'member' })
	).rejects.toThrow();
});

// seedConsent must seed the evidentiary defaults a consent row carries — the
// exact checkbox text, IP, and user agent are the audit evidence, and the
// doc version default tracks LEGAL_VERSION-era fixtures.
test('seedConsent seeds the evidentiary defaults', async () => {
	await seedUser('user-1');
	await seedConsent('user-1');
	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toMatchObject([
		{
			userId: 'user-1',
			email: 'user-1@example.com',
			docVersion: 'v1.2',
			checkboxText: 'I agree',
			ip: '127.0.0.1',
			userAgent: 'test',
			marketingOptIn: 0
		}
	]);
	expect(rows[0].createdAt).toEqual(expect.any(String));
});

test('seedConsent honors an explicit createdAt and docVersion override', async () => {
	await seedUser('user-1');
	await seedConsent('user-1', '2020-01-01T00:00:00.000Z', 'v1.1');
	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toMatchObject([{ createdAt: '2020-01-01T00:00:00.000Z', docVersion: 'v1.1' }]);
});
