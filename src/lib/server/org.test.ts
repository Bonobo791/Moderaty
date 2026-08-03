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
import { invites, memberships, organizations, sessions, users } from './db/schema';
import {
	acceptInvite,
	createInvite,
	createOrg,
	leaveOrg,
	listMembers,
	listOpenInvites,
	listOrgMemberships,
	previewInvite,
	removeMember,
	renameOrg,
	resolveActiveOrg,
	revokeInvite,
	setMemberRole,
	switchActiveOrg
} from './org';

// Phase B coverage first (session-resolution core); Phase D team-management
// behavior tests follow.
setupTestDb(['sessions', 'invites', 'memberships', 'organizations', 'users']);

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

// ---- Phase D: team management (D1 functions, D7 behaviors) ----

const T0 = '2026-01-01T00:00:00.000Z';

async function seedUser(userId: string) {
	await testDb()
		.db.insert(users)
		.values({ id: userId, googleSub: `sub-${userId}`, email: `${userId}@example.com`, displayName: userId });
}

async function seedOrg(orgId: string, personalFor: string | null = null) {
	await testDb().db.insert(organizations).values({ id: orgId, name: orgId, personalFor });
}

async function seedMember(userId: string, orgId: string, role: 'owner' | 'admin' | 'member', createdAt = T0) {
	await testDb().db.insert(memberships).values({ userId, orgId, role, createdAt });
}

async function seedSession(sessionId: string, userId: string, activeOrgId: string | null = null) {
	await testDb()
		.db.insert(sessions)
		.values({ id: sessionId, userId, activeOrgId, expiresAt: '2099-01-01T00:00:00.000Z' });
}

async function seedInvite(
	token: string,
	orgId: string,
	createdBy: string,
	overrides: { role?: string; expiresAt?: string; acceptedBy?: string | null } = {}
) {
	await testDb()
		.db.insert(invites)
		.values({
			token,
			orgId,
			role: overrides.role ?? 'member',
			createdBy,
			expiresAt: overrides.expiresAt ?? '2099-01-01T00:00:00.000Z',
			acceptedBy: overrides.acceptedBy ?? null
		});
}

async function membershipRow(userId: string, orgId: string) {
	return testDb()
		.db.select()
		.from(memberships)
		.where(eq(memberships.userId, userId))
		.all()
		.then((rows) => rows.filter((r) => r.orgId === orgId));
}

test('createOrg makes a shared org and the creator its owner; bad names are 400', async () => {
	await seedUser('user-1');
	const orgId = await createOrg('user-1', '  Team Rocket  ');
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, orgId)).get();
	expect(org?.name).toBe('Team Rocket');
	expect(org?.personalFor).toBeNull(); // shared, never personal
	const mine = await membershipRow('user-1', orgId);
	expect(mine).toHaveLength(1);
	expect(mine[0].role).toBe('owner');

	await expect(createOrg('user-1', '   ')).rejects.toMatchObject({ status: 400 });
	await expect(createOrg('user-1', 'x'.repeat(81))).rejects.toMatchObject({ status: 400 });
});

test('renameOrg requires admin; 404 for non-members, 403 for members, 400 for bad names', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedUser('outsider');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');

	await expect(renameOrg('outsider', 'org-1', 'New')).rejects.toMatchObject({ status: 404 });
	await expect(renameOrg('member-1', 'org-1', 'New')).rejects.toMatchObject({ status: 403 });
	await expect(renameOrg('owner-1', 'org-1', '')).rejects.toMatchObject({ status: 400 });

	await renameOrg('owner-1', 'org-1', 'Renamed');
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.name).toBe('Renamed');
});

test('createInvite is admin-only, member|admin roles only, and rejects personal orgs', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedUser('outsider');
	await seedOrg('org-1');
	await seedOrg('org-personal', 'owner-1'); // personal org
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedMember('owner-1', 'org-personal', 'owner');

	await expect(createInvite('outsider', 'org-1', 'member')).rejects.toMatchObject({ status: 404 });
	await expect(createInvite('member-1', 'org-1', 'member')).rejects.toMatchObject({ status: 403 });
	// Personal teams can never have members — no invite links into them (Phase C review).
	await expect(createInvite('owner-1', 'org-personal', 'member')).rejects.toMatchObject({ status: 400 });
	// TS stops 'owner' at compile time; a raw caller could still send it.
	await expect(createInvite('owner-1', 'org-1', 'owner' as 'member')).rejects.toMatchObject({ status: 400 });

	const token = await createInvite('owner-1', 'org-1', 'admin');
	const row = await testDb().db.select().from(invites).where(eq(invites.token, token)).get();
	expect(row?.role).toBe('admin');
	expect(row?.acceptedBy).toBeNull();
	expect(Date.parse(row!.expiresAt)).toBeGreaterThan(Date.now());
});

test('acceptInvite joins with the invite role, burns the token, and a second accept is 410', async () => {
	await seedUser('owner-1');
	await seedUser('joiner-1');
	await seedUser('joiner-2');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedSession('sess-1', 'joiner-1');
	const token = await createInvite('owner-1', 'org-1', 'admin');

	const orgId = await acceptInvite('joiner-1', 'sess-1', token);
	expect(orgId).toBe('org-1');
	const joined = await membershipRow('joiner-1', 'org-1');
	expect(joined).toHaveLength(1);
	expect(joined[0].role).toBe('admin');
	const burned = await testDb().db.select().from(invites).where(eq(invites.token, token)).get();
	expect(burned?.acceptedBy).toBe('joiner-1');
	// Session now points at the joined org.
	const sess = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get();
	expect(sess?.activeOrgId).toBe('org-1');

	// Single-use: a different user can never ride the same link.
	await seedSession('sess-2', 'joiner-2');
	await expect(acceptInvite('joiner-2', 'sess-2', token)).rejects.toMatchObject({ status: 410 });
	expect(await membershipRow('joiner-2', 'org-1')).toHaveLength(0);
});

test('acceptInvite is 410 for expired and unknown tokens, and rejects personal-org invites', async () => {
	await seedUser('owner-1');
	await seedUser('joiner-1');
	await seedOrg('org-1');
	await seedOrg('org-personal', 'owner-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedSession('sess-1', 'joiner-1');
	await seedInvite('tok-expired', 'org-1', 'owner-1', { expiresAt: '2020-01-01T00:00:00.000Z' });
	// Legacy/bad row: an invite that somehow points at a personal org (createInvite
	// blocks these at write time; accept must refuse them too — Phase C review).
	await seedInvite('tok-personal', 'org-personal', 'owner-1');

	await expect(acceptInvite('joiner-1', 'sess-1', 'tok-expired')).rejects.toMatchObject({ status: 410 });
	await expect(acceptInvite('joiner-1', 'sess-1', 'tok-nope')).rejects.toMatchObject({ status: 410 });
	await expect(acceptInvite('joiner-1', 'sess-1', 'tok-personal')).rejects.toMatchObject({ status: 400 });
	expect(await membershipRow('joiner-1', 'org-personal')).toHaveLength(0);
});

test('acceptInvite by an existing member is idempotent and does not burn the token', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedSession('sess-1', 'member-1');
	const token = await createInvite('owner-1', 'org-1', 'admin');

	await acceptInvite('member-1', 'sess-1', token);
	const rows = await membershipRow('member-1', 'org-1');
	expect(rows).toHaveLength(1); // no duplicate membership
	const sess = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get();
	expect(sess?.activeOrgId).toBe('org-1'); // still switches the session
});

test('setMemberRole: owner-only, last owner cannot be demoted, promotion to owner works', async () => {
	await seedUser('owner-1');
	await seedUser('admin-1');
	await seedUser('member-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('admin-1', 'org-1', 'admin');
	await seedMember('member-1', 'org-1', 'member');

	await expect(setMemberRole('member-1', 'org-1', 'admin-1', 'member')).rejects.toMatchObject({ status: 403 });
	await expect(setMemberRole('admin-1', 'org-1', 'member-1', 'admin')).rejects.toMatchObject({ status: 403 });
	// Last-owner demotion is blocked — even by that owner themselves.
	await expect(setMemberRole('owner-1', 'org-1', 'owner-1', 'admin')).rejects.toMatchObject({ status: 400 });
	await expect(setMemberRole('owner-1', 'org-1', 'ghost', 'member')).rejects.toMatchObject({ status: 404 });

	await setMemberRole('owner-1', 'org-1', 'member-1', 'owner');
	const promoted = await membershipRow('member-1', 'org-1');
	expect(promoted[0].role).toBe('owner');
	// With two owners, demoting one is allowed.
	await setMemberRole('owner-1', 'org-1', 'member-1', 'member');
	expect((await membershipRow('member-1', 'org-1'))[0].role).toBe('member');
});

test('removeMember: hierarchy enforced, owners never removed, no self-removal', async () => {
	await seedUser('owner-1');
	await seedUser('admin-1');
	await seedUser('admin-2');
	await seedUser('member-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('admin-1', 'org-1', 'admin');
	await seedMember('admin-2', 'org-1', 'admin');
	await seedMember('member-1', 'org-1', 'member');

	await expect(removeMember('admin-1', 'org-1', 'admin-1')).rejects.toMatchObject({ status: 400 }); // self
	await expect(removeMember('admin-1', 'org-1', 'owner-1')).rejects.toMatchObject({ status: 403 }); // owner target
	await expect(removeMember('admin-1', 'org-1', 'admin-2')).rejects.toMatchObject({ status: 403 }); // admin target
	await expect(removeMember('member-1', 'org-1', 'member-1')).rejects.toMatchObject({ status: 400 }); // self beats role check
	await expect(removeMember('owner-1', 'org-1', 'ghost')).rejects.toMatchObject({ status: 404 });

	await removeMember('admin-1', 'org-1', 'member-1'); // admin removes member
	expect(await membershipRow('member-1', 'org-1')).toHaveLength(0);
	await removeMember('owner-1', 'org-1', 'admin-2'); // owner removes admin
	expect(await membershipRow('admin-2', 'org-1')).toHaveLength(0);
});

test('leaveOrg: sole member and last-owner-with-members blocked; member leaves, active org cleared', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedOrg('org-1');
	await seedOrg('org-solo');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedMember('owner-1', 'org-solo', 'owner');
	await seedSession('sess-1', 'member-1', 'org-1');
	await seedSession('sess-2', 'owner-1', 'org-solo');

	await expect(leaveOrg('owner-1', 'sess-2', 'org-solo')).rejects.toMatchObject({ status: 400 }); // sole member
	await expect(leaveOrg('owner-1', 'sess-2', 'org-1')).rejects.toMatchObject({ status: 400 }); // last owner with members
	await expect(leaveOrg('ghost', 'sess-2', 'org-1')).rejects.toMatchObject({ status: 404 });

	await leaveOrg('member-1', 'sess-1', 'org-1');
	expect(await membershipRow('member-1', 'org-1')).toHaveLength(0);
	const sess = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get();
	expect(sess?.activeOrgId).toBeNull(); // falls back to oldest remaining membership
});

test('switchActiveOrg requires membership and updates sessions.active_org_id', async () => {
	await seedUser('user-1');
	await seedOrg('org-1');
	await seedOrg('org-2');
	await seedMember('user-1', 'org-1', 'member');
	await seedSession('sess-1', 'user-1', 'org-1');

	await expect(switchActiveOrg('user-1', 'sess-1', 'org-2')).rejects.toMatchObject({ status: 404 });
	await expect(switchActiveOrg('user-1', 'sess-1', 'org-gone')).rejects.toMatchObject({ status: 404 });

	await seedMember('user-1', 'org-2', 'admin');
	await switchActiveOrg('user-1', 'sess-1', 'org-2');
	const sess = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get();
	expect(sess?.activeOrgId).toBe('org-2');
});

test('previewInvite returns null for unknown tokens and flags expired/accepted', async () => {
	await seedUser('owner-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedInvite('tok-open', 'org-1', 'owner-1', { role: 'admin' });
	await seedInvite('tok-expired', 'org-1', 'owner-1', { expiresAt: '2020-01-01T00:00:00.000Z' });
	await seedInvite('tok-used', 'org-1', 'owner-1', { acceptedBy: 'owner-1' });

	expect(await previewInvite('tok-nope')).toBeNull(); // null, never a leak
	expect(await previewInvite('tok-open')).toEqual({ orgName: 'org-1', role: 'admin', expired: false, accepted: false });
	expect((await previewInvite('tok-expired'))?.expired).toBe(true);
	expect((await previewInvite('tok-used'))?.accepted).toBe(true);
});

test('listMembers requires membership, orders oldest-first (ties by user id), flags isYou', async () => {
	await seedUser('user-a');
	await seedUser('user-b');
	await seedUser('outsider');
	await seedOrg('org-1');
	// Same createdAt: tie must break by user id, in SQL — never localeCompare.
	await seedMember('user-b', 'org-1', 'member', T0);
	await seedMember('user-a', 'org-1', 'owner', T0);

	await expect(listMembers('outsider', 'org-1')).rejects.toMatchObject({ status: 404 });
	const roster = await listMembers('user-b', 'org-1');
	expect(roster.map((m) => m.userId)).toEqual(['user-a', 'user-b']);
	expect(roster[0]).toMatchObject({ role: 'owner', isYou: false });
	expect(roster[1]).toMatchObject({ role: 'member', isYou: true });
});

test('listOpenInvites is admin-only and returns only unexpired, unaccepted invites', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedInvite('tok-open', 'org-1', 'owner-1');
	await seedInvite('tok-expired', 'org-1', 'owner-1', { expiresAt: '2020-01-01T00:00:00.000Z' });
	await seedInvite('tok-used', 'org-1', 'owner-1', { acceptedBy: 'member-1' });

	await expect(listOpenInvites('member-1', 'org-1')).rejects.toMatchObject({ status: 403 });
	const open = await listOpenInvites('owner-1', 'org-1');
	expect(open.map((i) => i.token)).toEqual(['tok-open']);
});

test('revokeInvite deletes the invite, admin of its org only', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedUser('other-owner');
	await seedOrg('org-1');
	await seedOrg('org-2');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedMember('other-owner', 'org-2', 'owner');
	await seedInvite('tok-1', 'org-1', 'owner-1');

	await expect(revokeInvite('owner-1', 'tok-nope')).rejects.toMatchObject({ status: 404 });
	// Admin of a DIFFERENT org reads as 404 — never leak which org an invite serves.
	await expect(revokeInvite('other-owner', 'tok-1')).rejects.toMatchObject({ status: 404 });
	await expect(revokeInvite('member-1', 'tok-1')).rejects.toMatchObject({ status: 403 });

	await revokeInvite('owner-1', 'tok-1');
	expect(await testDb().db.select().from(invites).where(eq(invites.token, 'tok-1')).get()).toBeUndefined();
});
