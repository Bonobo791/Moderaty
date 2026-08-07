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

import { seedUser, setupTestDb, testDb } from './testdb';
import { invites, memberships, organizations, sessions, users } from './db/schema';
import { getSessionUser } from './session';
import {
	acceptInvite,
	createInvite,
	createOrg,
	ensurePersonalOrg,
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

	const result = await acceptInvite('joiner-1', 'sess-1', token);
	expect(result.orgId).toBe('org-1');
	const joined = await membershipRow('joiner-1', 'org-1');
	expect(joined).toHaveLength(1);
	expect(joined[0].role).toBe('admin');
	const burned = await testDb().db.select().from(invites).where(eq(invites.token, token)).get();
	expect(burned?.acceptedBy).toBe('joiner-1');
	// Rotation: the old token dies; the replacement resolves at the joined org.
	expect(await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get()).toBeUndefined();
	expect(await getSessionUser(result.session.token)).toMatchObject({
		user: { id: 'joiner-1', orgId: 'org-1', orgRole: 'admin' }
	});

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

test('acceptInvite by an existing member is idempotent, still burns the token', async () => {
	// PR #52 review (Amazon Q): single-use means EVERY accept burns — an
	// already-a-member accept must not leave the link usable by someone else.
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedUser('joiner-2');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedSession('sess-1', 'member-1');
	const token = await createInvite('owner-1', 'org-1', 'admin');

	const result = await acceptInvite('member-1', 'sess-1', token);
	const rows = await membershipRow('member-1', 'org-1');
	expect(rows).toHaveLength(1); // no duplicate membership
	expect(rows[0].role).toBe('member'); // and the existing role is kept
	const burned = await testDb().db.select().from(invites).where(eq(invites.token, token)).get();
	expect(burned?.acceptedBy).toBe('member-1'); // burned even for an existing member
	// Rotation: the old token dies and the replacement still switches the org.
	expect(await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get()).toBeUndefined();
	expect(await getSessionUser(result.session.token)).toMatchObject({ user: { id: 'member-1', orgId: 'org-1' } });

	// The burned link is dead for everyone else, too.
	await seedSession('sess-2', 'joiner-2');
	await expect(acceptInvite('joiner-2', 'sess-2', token)).rejects.toMatchObject({ status: 410 });
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

test('removeMember: a plain member cannot remove another member', async () => {
	// Mutation audit: deleting the admin gate stayed green because no test had
	// a member caller removing SOMEONE ELSE — every caller above was admin/owner
	// or tripped an earlier guard. A member caller must 403, never escalate.
	await seedUser('member-1');
	await seedUser('member-2');
	await seedOrg('org-1');
	await seedMember('member-1', 'org-1', 'member');
	await seedMember('member-2', 'org-1', 'member');

	await expect(removeMember('member-1', 'org-1', 'member-2')).rejects.toMatchObject({ status: 403 });
	expect(await membershipRow('member-2', 'org-1')).toHaveLength(1);
});

test('ensurePersonalOrg is idempotent when called repeatedly for the same signup', async () => {
	// Mutation audit: deleting the existence check stayed green because no test
	// consents the same new sub twice — the loser of the user-insert race must
	// find the org the winner already made (I4), not duplicate it.
	await seedUser('user-1');

	const first = await ensurePersonalOrg(testDb().db, { id: 'user-1', displayName: 'user-1' });
	const second = await ensurePersonalOrg(testDb().db, { id: 'user-1', displayName: 'user-1' });

	expect(second).toBe(first);
	expect(
		await testDb().db.select().from(organizations).where(eq(organizations.personalFor, 'user-1')).all()
	).toHaveLength(1);
	expect(
		await testDb().db.select().from(memberships).where(eq(memberships.userId, 'user-1')).all()
	).toHaveLength(1);
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
	const rotated = await switchActiveOrg('user-1', 'sess-1', 'org-2');
	// Rotation: the old token dies; the replacement resolves at the target org.
	expect(await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get()).toBeUndefined();
	expect(await getSessionUser(rotated.token)).toMatchObject({ user: { id: 'user-1', orgId: 'org-2', orgRole: 'admin' } });
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

test('switchActiveOrg fails loudly when the session token is not the caller\'s', async () => {
	// PR #52 review (Qodo): session updates must be scoped to the caller AND
	// verified — an unknown/mismatched token must never silently succeed.
	await seedUser('user-1');
	await seedUser('user-2');
	await seedOrg('org-1');
	await seedMember('user-1', 'org-1', 'member');
	await seedMember('user-2', 'org-1', 'member');
	await seedSession('sess-2', 'user-2');

	await expect(switchActiveOrg('user-1', 'sess-2', 'org-1')).rejects.toMatchObject({ status: 401 });
	await expect(switchActiveOrg('user-1', 'sess-ghost', 'org-1')).rejects.toMatchObject({ status: 401 });
	const sess = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-2')).get();
	expect(sess?.activeOrgId).toBeNull(); // another user's session untouched
});

test('acceptInvite with a mismatched session token is 401 and neither burns nor joins', async () => {
	await seedUser('owner-1');
	await seedUser('joiner-1');
	await seedUser('user-2');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('user-2', 'org-1', 'member');
	await seedSession('sess-2', 'user-2');
	const token = await createInvite('owner-1', 'org-1', 'member');

	await expect(acceptInvite('joiner-1', 'sess-2', token)).rejects.toMatchObject({ status: 401 });
	const inv = await testDb().db.select().from(invites).where(eq(invites.token, token)).get();
	expect(inv?.acceptedBy).toBeNull(); // not burned
	expect(await membershipRow('joiner-1', 'org-1')).toHaveLength(0); // not joined
	const sess = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-2')).get();
	expect(sess?.activeOrgId).toBeNull(); // another user's session untouched
});

test('leaveOrg clears only the caller\'s own session', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedUser('member-2');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedMember('member-2', 'org-1', 'member');
	await seedSession('sess-1', 'member-1', 'org-1');
	await seedSession('sess-2', 'member-2', 'org-1');

	await leaveOrg('member-1', 'sess-1', 'org-1');
	const own = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get();
	expect(own?.activeOrgId).toBeNull();
	const other = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-2')).get();
	expect(other?.activeOrgId).toBe('org-1'); // teammate's session untouched
});

test('setMemberRole rejects an unknown role with 400 (PR #52 review — untested guard)', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');

	await expect(setMemberRole('owner-1', 'org-1', 'member-1', 'superadmin' as 'member')).rejects.toMatchObject({
		status: 400,
		body: { message: 'unknown role' }
	});
	expect((await membershipRow('member-1', 'org-1'))[0].role).toBe('member'); // unchanged
});

// ---- Mutation-audit hardening: loud failures, exact messages, boundaries ----

test('asOrgRole throws on an unknown membership role instead of returning it', async () => {
	// A corrupt role must fail loudly (fail-closed), never pass through as a role.
	await seedUser('user-1');
	await seedOrg('org-1');
	await seedMember('user-1', 'org-1', 'bogus' as 'member');

	await expect(resolveActiveOrg('user-1', null)).rejects.toThrow('unknown membership role: bogus');
	await expect(listOrgMemberships('user-1')).rejects.toThrow('unknown membership role: bogus');
});

test('asInviteRole throws on an unknown invite role instead of returning it', async () => {
	await seedUser('owner-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedInvite('tok-bogus', 'org-1', 'owner-1', { role: 'bogus' });

	await expect(previewInvite('tok-bogus')).rejects.toThrow('invite tok-bogus has unknown role: bogus');
	await expect(listOpenInvites('owner-1', 'org-1')).rejects.toThrow('invite tok-bogus has unknown role: bogus');
});

test('resolveActiveOrg picks the explicit active org even when it is not the oldest membership', async () => {
	// Mutation audit: rows.find(...) degraded to rows[0] (or the ?? flipped)
	// silently dropped the session's org choice whenever it was not the oldest,
	// and forcing the fellBack expression true misreported a valid pick.
	await seedUserWithOrgs('user-1', ['org-a', 'org-b'], T0);

	const resolved = await resolveActiveOrg('user-1', 'org-b');
	expect(resolved?.org).toEqual({ orgId: 'org-b', orgName: 'org-b', orgRole: 'member', plan: 'free' });
	expect(resolved?.fellBack).toBe(false);
});

test('team names accept exactly 80 characters and reject 81 (create and rename)', async () => {
	// Mutation audit: `trimmed.length > 80` flipped to >= rejected the longest
	// legal name; only a boundary-length name catches it.
	await seedUser('owner-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');

	const exact = 'x'.repeat(80);
	const orgId = await createOrg('owner-1', `  ${exact}  `); // padding is trimmed before measuring
	const created = await testDb().db.select().from(organizations).where(eq(organizations.id, orgId)).get();
	expect(created?.name).toBe(exact);

	await renameOrg('owner-1', 'org-1', exact);
	const renamed = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(renamed?.name).toBe(exact);

	await expect(createOrg('owner-1', 'x'.repeat(81))).rejects.toMatchObject({
		status: 400,
		body: { message: 'team name must be 1–80 characters' }
	});
	await expect(renameOrg('owner-1', 'org-1', 'x'.repeat(81))).rejects.toMatchObject({
		status: 400,
		body: { message: 'team name must be 1–80 characters' }
	});
});

test('renameOrg stores the trimmed name, and whitespace-only is 400', async () => {
	// Mutation audit: dropping .trim() stored padded names and let padded
	// whitespace through the emptiness check.
	await seedUser('owner-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');

	await renameOrg('owner-1', 'org-1', '  Padded Name  ');
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.name).toBe('Padded Name');

	await expect(renameOrg('owner-1', 'org-1', '   ')).rejects.toMatchObject({
		status: 400,
		body: { message: 'team name must be 1–80 characters' }
	});
});

test('renameOrg guard messages: 404 for outsiders, 403 for plain members', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedUser('outsider');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');

	await expect(renameOrg('outsider', 'org-1', 'New')).rejects.toMatchObject({
		status: 404,
		body: { message: 'team not found' }
	});
	await expect(renameOrg('member-1', 'org-1', 'New')).rejects.toMatchObject({
		status: 403,
		body: { message: 'your team role does not allow this' }
	});
});

test('createInvite guard messages: 404 outsider, 403 member, 400 personal, 400 bad role', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedUser('outsider');
	await seedOrg('org-1');
	await seedOrg('org-personal', 'owner-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedMember('owner-1', 'org-personal', 'owner');

	await expect(createInvite('outsider', 'org-1', 'member')).rejects.toMatchObject({
		status: 404,
		body: { message: 'team not found' }
	});
	await expect(createInvite('member-1', 'org-1', 'member')).rejects.toMatchObject({
		status: 403,
		body: { message: 'your team role does not allow this' }
	});
	await expect(createInvite('owner-1', 'org-personal', 'member')).rejects.toMatchObject({
		status: 400,
		body: { message: "personal teams can't have members — create a shared team to collaborate" }
	});
	await expect(createInvite('owner-1', 'org-1', 'owner' as 'member')).rejects.toMatchObject({
		status: 400,
		body: { message: 'invite role must be admin or member' }
	});
});

test('an invite expiring exactly now counts as expired in preview and accept', async () => {
	// Mutation audit: `<= Date.now()` flipped to `<` resurrected invites at their
	// exact expiry instant; only a boundary-timestamp invite catches it.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
	try {
		await seedUser('owner-1');
		await seedUser('joiner-1');
		await seedOrg('org-1');
		await seedMember('owner-1', 'org-1', 'owner');
		await seedSession('sess-1', 'joiner-1');
		await seedInvite('tok-now', 'org-1', 'owner-1', { expiresAt: '2026-06-01T12:00:00.000Z' });

		expect((await previewInvite('tok-now'))?.expired).toBe(true);
		await expect(acceptInvite('joiner-1', 'sess-1', 'tok-now')).rejects.toMatchObject({
			status: 410,
			body: { message: 'this invite link is no longer valid — ask for a new one' }
		});
		expect(await membershipRow('joiner-1', 'org-1')).toHaveLength(0);
	} finally {
		vi.useRealTimers();
	}
});

test('acceptInvite guard messages: expired/unknown 410, personal 400, mismatched session 401', async () => {
	await seedUser('owner-1');
	await seedUser('joiner-1');
	await seedUser('user-2');
	await seedOrg('org-1');
	await seedOrg('org-personal', 'owner-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedSession('sess-1', 'joiner-1');
	await seedSession('sess-2', 'user-2');
	await seedInvite('tok-expired', 'org-1', 'owner-1', { expiresAt: '2020-01-01T00:00:00.000Z' });
	await seedInvite('tok-personal', 'org-personal', 'owner-1');
	await seedInvite('tok-open', 'org-1', 'owner-1');

	await expect(acceptInvite('joiner-1', 'sess-1', 'tok-expired')).rejects.toMatchObject({
		status: 410,
		body: { message: 'this invite link is no longer valid — ask for a new one' }
	});
	await expect(acceptInvite('joiner-1', 'sess-1', 'tok-personal')).rejects.toMatchObject({
		status: 400,
		body: { message: 'this invite points at a personal team — ask for a shared-team invite' }
	});
	await expect(acceptInvite('joiner-1', 'sess-2', 'tok-open')).rejects.toMatchObject({
		status: 401,
		body: { message: 'sign-in required' }
	});
});

test('switchActiveOrg guard messages: 404 without membership, 401 for another session', async () => {
	await seedUser('user-1');
	await seedUser('user-2');
	await seedOrg('org-1');
	await seedOrg('org-2');
	await seedMember('user-1', 'org-1', 'member');
	await seedSession('sess-1', 'user-1');
	await seedSession('sess-2', 'user-2');

	await expect(switchActiveOrg('user-1', 'sess-1', 'org-2')).rejects.toMatchObject({
		status: 404,
		body: { message: 'team not found' }
	});
	await expect(switchActiveOrg('user-1', 'sess-2', 'org-1')).rejects.toMatchObject({
		status: 401,
		body: { message: 'sign-in required' }
	});
});

test('listMembers and listOpenInvites read outsiders as 404 with the guard message', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedUser('outsider');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');

	await expect(listMembers('outsider', 'org-1')).rejects.toMatchObject({
		status: 404,
		body: { message: 'team not found' }
	});
	await expect(listOpenInvites('outsider', 'org-1')).rejects.toMatchObject({
		status: 404,
		body: { message: 'team not found' }
	});
	await expect(listOpenInvites('member-1', 'org-1')).rejects.toMatchObject({
		status: 403,
		body: { message: 'your team role does not allow this' }
	});
});

test('revokeInvite guard messages: 404 unknown token, 404 foreign admin, 403 member', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedUser('other-owner');
	await seedOrg('org-1');
	await seedOrg('org-2');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedMember('other-owner', 'org-2', 'owner');
	await seedInvite('tok-1', 'org-1', 'owner-1');

	await expect(revokeInvite('owner-1', 'tok-nope')).rejects.toMatchObject({
		status: 404,
		body: { message: 'invite not found' }
	});
	await expect(revokeInvite('other-owner', 'tok-1')).rejects.toMatchObject({
		status: 404,
		body: { message: 'invite not found' }
	});
	await expect(revokeInvite('member-1', 'tok-1')).rejects.toMatchObject({
		status: 403,
		body: { message: 'your team role does not allow this' }
	});
});

test('setMemberRole promotes a member to admin with a sole owner, and re-setting owner is a no-op', async () => {
	// Mutation audit: `target.role === 'owner' && role !== 'owner'` flipped to ||
	// routed EVERY non-owner promotion through the demotion guard, blocking it
	// without a second owner; `'owner' !== role` blanked treated re-setting an
	// owner as a demotion. Both must behave as plain updates.
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');

	await setMemberRole('owner-1', 'org-1', 'member-1', 'admin');
	expect((await membershipRow('member-1', 'org-1'))[0].role).toBe('admin');

	await setMemberRole('owner-1', 'org-1', 'owner-1', 'owner'); // no-op, must not trip the demotion guard
	expect((await membershipRow('owner-1', 'org-1'))[0].role).toBe('owner');
});

test('setMemberRole invalidates the target\'s sessions when the role actually changes', async () => {
	// Roles resolve live from memberships, so a token minted before a role
	// change would instantly gain the new privilege. We cannot rotate tokens we
	// do not hold, so the target's rows are deleted — their next page load asks
	// them to sign in again (re-authentication on privilege change).
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedSession('sess-a', 'member-1');
	await seedSession('sess-b', 'member-1');
	await seedSession('sess-owner', 'owner-1');

	await setMemberRole('owner-1', 'org-1', 'member-1', 'admin');

	// Every pre-change token of the promoted member is dead.
	expect(await testDb().db.select().from(sessions).where(eq(sessions.userId, 'member-1')).all()).toEqual([]);
	// The caller's own sessions are untouched.
	expect((await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-owner')).get())?.userId).toBe('owner-1');
});

test('setMemberRole leaves the target\'s sessions alone when the role does not change', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedSession('sess-a', 'member-1');

	await setMemberRole('owner-1', 'org-1', 'member-1', 'member'); // same role — a plain no-op write

	expect((await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-a')).get())?.userId).toBe('member-1');
});

test('setMemberRole guard messages: 404 outsider caller, 404 ghost target, 400 last owner', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedUser('outsider');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');

	await expect(setMemberRole('outsider', 'org-1', 'member-1', 'admin')).rejects.toMatchObject({
		status: 404,
		body: { message: 'team not found' }
	});
	await expect(setMemberRole('owner-1', 'org-1', 'ghost', 'member')).rejects.toMatchObject({
		status: 404,
		body: { message: 'member not found' }
	});
	await expect(setMemberRole('owner-1', 'org-1', 'owner-1', 'admin')).rejects.toMatchObject({
		status: 400,
		body: { message: 'the last owner cannot be demoted — promote a teammate to owner first' }
	});
});

test('removeMember guard messages: self 400, outsider 404, ghost 404, owner/admin 403', async () => {
	await seedUser('owner-1');
	await seedUser('admin-1');
	await seedUser('member-1');
	await seedUser('outsider');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('admin-1', 'org-1', 'admin');
	await seedMember('member-1', 'org-1', 'member');

	await expect(removeMember('member-1', 'org-1', 'member-1')).rejects.toMatchObject({
		status: 400,
		body: { message: 'use Leave team to remove yourself' }
	});
	await expect(removeMember('outsider', 'org-1', 'member-1')).rejects.toMatchObject({
		status: 404,
		body: { message: 'team not found' }
	});
	await expect(removeMember('owner-1', 'org-1', 'ghost')).rejects.toMatchObject({
		status: 404,
		body: { message: 'member not found' }
	});
	await expect(removeMember('admin-1', 'org-1', 'owner-1')).rejects.toMatchObject({
		status: 403,
		body: { message: 'owners cannot be removed' }
	});
	await expect(removeMember('admin-1', 'org-1', 'admin-1')).rejects.toMatchObject({
		status: 400,
		body: { message: 'use Leave team to remove yourself' }
	});
	await seedUser('admin-2');
	await seedMember('admin-2', 'org-1', 'admin');
	await expect(removeMember('admin-1', 'org-1', 'admin-2')).rejects.toMatchObject({
		status: 403,
		body: { message: 'only an owner can remove an admin' }
	});
	expect(await membershipRow('member-1', 'org-1')).toHaveLength(1); // nothing was removed
});

test('leaveOrg guard messages: outsider 404, sole member 400, last owner 400', async () => {
	await seedUser('owner-1');
	await seedUser('member-1');
	await seedOrg('org-1');
	await seedOrg('org-solo');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedMember('owner-1', 'org-solo', 'owner');
	await seedSession('sess-1', 'owner-1', 'org-solo');

	await expect(leaveOrg('ghost', 'sess-1', 'org-1')).rejects.toMatchObject({
		status: 404,
		body: { message: 'team not found' }
	});
	await expect(leaveOrg('owner-1', 'sess-1', 'org-solo')).rejects.toMatchObject({
		status: 400,
		body: { message: 'you are the only member — delete your account to remove this team' }
	});
	await expect(leaveOrg('owner-1', 'sess-1', 'org-1')).rejects.toMatchObject({
		status: 400,
		body: { message: 'promote a teammate to owner before leaving' }
	});
});

test('leaveOrg lets an owner leave when another owner remains', async () => {
	// Mutation audit: `others.some(o => o.role === 'owner')` mutated to every()
	// blocked an owner from leaving whenever a non-owner teammate existed.
	await seedUser('owner-1');
	await seedUser('owner-2');
	await seedUser('member-1');
	await seedOrg('org-1');
	await seedMember('owner-1', 'org-1', 'owner');
	await seedMember('owner-2', 'org-1', 'owner');
	await seedMember('member-1', 'org-1', 'member');
	await seedSession('sess-1', 'owner-1', 'org-1');

	await leaveOrg('owner-1', 'sess-1', 'org-1');
	expect(await membershipRow('owner-1', 'org-1')).toHaveLength(0);
	const sess = await testDb().db.select().from(sessions).where(eq(sessions.id, 'sess-1')).get();
	expect(sess?.activeOrgId).toBeNull();
});

test('acceptInvite answers 410, not 400, for an already-used invite even into a personal team', async () => {
	// Mutation audit: blanking `inv.acceptedBy !== null` let a burned invite fall
	// through to the personal-team guard, leaking 400 where single-use semantics
	// demand 410 for every dead link.
	await seedUser('owner-1');
	await seedUser('joiner-1');
	await seedOrg('org-personal', 'owner-1');
	await seedSession('sess-1', 'joiner-1');
	await seedInvite('tok-used-personal', 'org-personal', 'owner-1', { acceptedBy: 'owner-1' });

	await expect(acceptInvite('joiner-1', 'sess-1', 'tok-used-personal')).rejects.toMatchObject({
		status: 410,
		body: { message: 'this invite link is no longer valid — ask for a new one' }
	});
});

test('leaveOrg lets a member leave a team whose remaining members include no owner', async () => {
	// Mutation audit: forcing `m.role === 'owner' && ...` true blocked ANY leaver
	// whose remaining teammates had no owner — a member must still walk free.
	await seedUser('member-1');
	await seedUser('member-2');
	await seedOrg('org-1');
	await seedMember('member-1', 'org-1', 'member');
	await seedMember('member-2', 'org-1', 'member');
	await seedSession('sess-1', 'member-1', 'org-1');

	await leaveOrg('member-1', 'sess-1', 'org-1');
	expect(await membershipRow('member-1', 'org-1')).toHaveLength(0);
	expect(await membershipRow('member-2', 'org-1')).toHaveLength(1);
});
