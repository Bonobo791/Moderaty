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

import { setupTestDb, testDb } from './testdb';
import { memberships, organizations, users } from './db/schema';
import { listOrgMemberships, resolveActiveOrg } from './org';

// Phase D adds the team-management behavior tests to this file; these cover
// the session-resolution core shipped in Phase B.
setupTestDb(['memberships', 'organizations', 'users']);

async function seedUserWithOrgs(userId: string, orgIds: string[], createdAt: string) {
	await testDb()
		.db.insert(users)
		.values({ id: userId, googleSub: `sub-${userId}`, email: `${userId}@example.com`, displayName: userId });
	for (const orgId of orgIds) {
		await testDb().db.insert(organizations).values({ id: orgId, name: orgId });
		await testDb().db.insert(memberships).values({ userId, orgId, role: 'member', createdAt });
	}
}

test('memberships tying on created_at resolve deterministically, consistently with the org list', async () => {
	// PR #49 review (Qodo/Codacy): "oldest membership" must be a total order —
	// a timestamp tie (batched inserts) must not let the active org flip with
	// undefined DB row order. Tie-break is org id, and the nav list must agree.
	// Inserted b-first on purpose: insertion order must NOT decide the winner.
	await seedUserWithOrgs('user-1', ['org-b', 'org-a'], '2026-01-01T00:00:00.000Z');

	const resolved = await resolveActiveOrg('user-1', null);
	expect(resolved?.org.orgId).toBe('org-a');

	const list = await listOrgMemberships('user-1');
	expect(list.map((o) => o.orgId)).toEqual(['org-a', 'org-b']);
});

test('fellBack is false when the session had no explicit active org', async () => {
	// PR #49 review (Qodo): fellBack means "an explicit org choice became
	// invalid" — a null active_org_id is the ordinary fresh-login case, not a
	// fallback.
	await seedUserWithOrgs('user-1', ['org-a'], '2026-01-01T00:00:00.000Z');

	const fresh = await resolveActiveOrg('user-1', null);
	expect(fresh?.fellBack).toBe(false);

	const vanished = await resolveActiveOrg('user-1', 'org-gone');
	expect(vanished?.fellBack).toBe(true);
	expect(vanished?.org.orgId).toBe('org-a');
});
