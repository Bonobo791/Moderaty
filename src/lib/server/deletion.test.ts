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

import { and, eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';

import { DAY_MS, seedConsent, seedUser as seedBareUser, setupTestDb, testDb } from './testdb';
import { auditLog, channels, comments, consents, invites, memberships, moderationActions, organizations, rules, sessions, users } from './db/schema';
import {
	CONSENT_EMAIL_RETENTION_MS,
	WIPED_REFRESH_TOKEN,
	consentEmailCutoffIso,
	deleteUserRecords,
	nullExpiredConsentEmails
} from './deletion';

setupTestDb(['moderation_actions', 'comments', 'audit_log', 'rules', 'channels', 'sessions', 'consents', 'invites', 'memberships', 'organizations', 'users']);

/** Seeds one comment plus its moderation action, audit row, and keyword rule for a channel. */
async function seedModerationData(channelId: string, key: string) {
	await testDb().db.insert(comments).values({
		id: `comment-${key}`,
		channelId,
		text: 'hi',
		publishedAt: '2026-01-01T00:00:00.000Z',
		status: 'approved',
		decidedBy: 'ai'
	});
	await testDb().db.insert(moderationActions).values({
		commentId: `comment-${key}`,
		channelId,
		action: 'delete',
		reason: 'test',
		state: 'completed'
	});
	await testDb()
		.db.insert(auditLog)
		.values({ channelId, commentId: `comment-${key}`, action: 'delete', reason: 'test', actor: 'system' });
	await testDb()
		.db.insert(rules)
		.values({ channelId, type: 'keyword', pattern: 'spam', action: 'delete' });
}

/** Seeds a channel row with the standard shape (placeholder enc token). */
async function seedChannel(id: string, userId: string | null, orgId: string, title: string) {
	await testDb().db.insert(channels).values({ id, userId, orgId, title, refreshTokenEnc: 'enc' });
}

async function seedUser(id: string) {
	await seedBareUser(id);
	// Every real user has a personal org (0012 backfill / signup) — an org row
	// named after them, an owner membership, and (Phase D shape) an invite.
	await testDb()
		.db.insert(organizations)
		.values({ id: `org-${id}`, name: id, personalFor: id });
	await testDb().db.insert(memberships).values({ userId: id, orgId: `org-${id}`, role: 'owner' });
	await testDb()
		.db.insert(invites)
		.values({ token: `invite-${id}`, orgId: `org-${id}`, role: 'member', createdBy: id, expiresAt: new Date(Date.now() + DAY_MS).toISOString() });
	await seedChannel(`UC-${id}`, id, `org-${id}`, `channel ${id}`);
	await testDb()
		.db.insert(sessions)
		.values({ id: `token-${id}`, userId: id, expiresAt: new Date(Date.now() + DAY_MS).toISOString() });
	await seedModerationData(`UC-${id}`, id);
	return id;
}

async function userRow(id: string) {
	return await testDb().db.select().from(users).where(eq(users.id, id)).get();
}

/** Asserts every moderation and tenancy table is empty (consents/users asserted separately — they are retained/tombstoned). */
async function expectAllTablesEmpty() {
	for (const table of [channels, sessions, comments, moderationActions, auditLog, rules, organizations, memberships, invites]) {
		expect(await testDb().db.select().from(table).all()).toEqual([]);
	}
}

test('deleteUserRecords erases every owned record and tombstones the user fully', async () => {
	const userId = await seedUser('gone');
	await seedConsent(userId);

	await deleteUserRecords(userId);

	// The user's tenancy goes too: the personal org (its name is the user's
	// display name — PII), all memberships, and invites they created.
	await expectAllTablesEmpty();
	expect(await userRow(userId)).toMatchObject({
		googleSub: `deleted:${userId}`,
		email: '[deleted]',
		displayName: '[deleted]'
	});
	// Statutory retention: the consent log survives, WITH the e-mail (Art. 16, III).
	const retained = await testDb().db.select().from(consents).all();
	expect(retained).toHaveLength(1);
	expect(retained[0]).toMatchObject({ userId, email: 'gone@example.com' });
});

test('deleteUserRecords refuses to erase a personal org that somehow has a second member', async () => {
	// Data-bug guard: a personal org is single-member by definition, but the
	// schema cannot enforce that. If one ever gains a second member, deleting
	// the org would silently destroy that member's tenancy and channels —
	// fail loudly instead (deletion aborts, everything rolls back).
	const userId = await seedUser('gone');
	await seedBareUser('member-2');
	await testDb().db.insert(memberships).values({ userId: 'member-2', orgId: 'org-gone', role: 'member' });

	await expect(deleteUserRecords(userId)).rejects.toThrow('personal organization has other members');

	// Nothing was erased: the tombstone never happened and all rows survive.
	expect(await userRow(userId)).toMatchObject({ googleSub: 'sub-gone' });
	expect(await testDb().db.select().from(channels).all()).toHaveLength(1);
	expect(await testDb().db.select().from(memberships).all()).toHaveLength(2);
	expect(await testDb().db.select().from(organizations).all()).toHaveLength(1);
});

test('deleteUserRecords refuses when the sole personal-org member is someone else', async () => {
	// Sharper edge of the same data bug: the count is 1 (passes a naive count
	// guard) but the sole membership belongs to a DIFFERENT user — deleting
	// the org would erase that user's tenancy and channels.
	const userId = await seedUser('gone');
	await testDb()
		.db.delete(memberships)
		.where(and(eq(memberships.userId, userId), eq(memberships.orgId, 'org-gone')));
	await seedBareUser('squatter');
	await testDb().db.insert(memberships).values({ userId: 'squatter', orgId: 'org-gone', role: 'owner' });

	await expect(deleteUserRecords(userId)).rejects.toThrow('personal organization has other members');

	expect(await userRow(userId)).toMatchObject({ googleSub: 'sub-gone' });
	expect(await testDb().db.select().from(organizations).all()).toHaveLength(1);
	expect(await testDb().db.select().from(channels).all()).toHaveLength(1);
});

test('deleteUserRecords keeps team channels the user merely connected, wiping their connector credentials', async () => {
	// The user is the CONNECTOR (channels.userId) of a channel in a SHARED org
	// that survives them: the channel and its moderation history belong to the
	// team, not the departing account (C2 semantics — the dead token fails
	// loudly in cron until a teammate reconnects).
	const userId = await seedUser('gone');
	await testDb().db.insert(organizations).values({ id: 'org-team', name: 'Team' });
	await seedChannel('UC-team', userId, 'org-team', 'team channel');
	await seedModerationData('UC-team', 'team');

	await deleteUserRecords(userId);

	// The team channel survives, detached: connector nulled, token wiped with
	// the exact sentinel so cron fails loudly instead of silently moderating
	// with a dead grant.
	const team = (await testDb().db.select().from(channels).all()).find((c) => c.id === 'UC-team');
	expect(team).toBeDefined();
	expect(team?.userId).toBeNull();
	expect(team?.refreshTokenEnc).toBe(WIPED_REFRESH_TOKEN);
	// Its moderation history and rules are the team's — untouched.
	expect((await testDb().db.select().from(comments).all()).map((c) => c.id)).toEqual(['comment-team']);
	expect(await testDb().db.select().from(rules).all()).toHaveLength(1);
	// The personal org is still fully erased (channel, org, memberships).
	expect((await testDb().db.select().from(channels).all()).find((c) => c.id === 'UC-gone')).toBeUndefined();
	expect(await testDb().db.select().from(organizations).all()).toEqual([expect.objectContaining({ id: 'org-team' })]);
});

test('deleteUserRecords leaves other users and their records alone', async () => {
	const userId = await seedUser('gone');
	await seedUser('stays');
	await seedConsent('stays');

	await deleteUserRecords(userId);

	expect(await userRow('stays')).toMatchObject({ googleSub: 'sub-stays', email: 'stays@example.com' });
	expect((await testDb().db.select().from(channels).all()).map((ch) => ch.id)).toEqual(['UC-stays']);
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(1);
	expect(await testDb().db.select().from(consents).all()).toHaveLength(1);
	// ...including the survivor's tenancy.
	expect((await testDb().db.select().from(organizations).all()).map((o) => o.id)).toEqual(['org-stays']);
	expect(await testDb().db.select().from(memberships).all()).toHaveLength(1);
	expect(await testDb().db.select().from(invites).all()).toHaveLength(1);
});

test('deleteUserRecords works for a user with no channels', async () => {
	await seedBareUser('solo');

	await deleteUserRecords('solo');

	expect(await userRow('solo')).toMatchObject({ googleSub: 'deleted:solo', email: '[deleted]' });
});

test('the tombstone frees the Google sub for a fresh signup', async () => {
	const userId = await seedUser('gone');
	await deleteUserRecords(userId);

	await testDb()
		.db.insert(users)
		.values({ id: 'new-user', googleSub: 'sub-gone', email: 'gone@example.com', displayName: 'gone again' });

	expect(await userRow('new-user')).toMatchObject({ googleSub: 'sub-gone' });
});

test('deleteUserRecords rejects re-deleting an already tombstoned user', async () => {
	const userId = await seedUser('gone');
	await seedConsent(userId);

	await deleteUserRecords(userId);

	await expect(deleteUserRecords(userId)).rejects.toThrow(`deleteUserRecords: user ${userId} not found or already deleted`);

	// The rejected second call must leave the tombstone and consent log untouched.
	expect(await userRow(userId)).toMatchObject({ googleSub: `deleted:${userId}` });
	expect(await testDb().db.select().from(users).all()).toHaveLength(1);
	const retained = await testDb().db.select().from(consents).all();
	expect(retained).toHaveLength(1);
	expect(retained[0]).toMatchObject({ userId, email: 'gone@example.com' });
});

test('deleteUserRecords rejects a nonexistent user id', async () => {
	await expect(deleteUserRecords('no-such-user')).rejects.toThrow(
		'deleteUserRecords: user no-such-user not found or already deleted'
	);
	expect(await testDb().db.select().from(users).all()).toEqual([]);
});

/** Seeds a SHARED org (personalFor null) with members in an explicit join order (createdAt drives succession seniority). */
async function seedSharedOrg(orgId: string, members: { userId: string; role: string; joinedAt: string }[]) {
	await testDb().db.insert(organizations).values({ id: orgId, name: orgId });
	for (const member of members) {
		await testDb().db.insert(memberships).values({ userId: member.userId, orgId, role: member.role, createdAt: member.joinedAt });
	}
}

async function teamMemberships(orgId: string) {
	return await testDb().db.select().from(memberships).where(eq(memberships.orgId, orgId)).all();
}

/** Asserts the exact membership roster (userId/role pairs, order-insensitive) of an org. */
async function expectOrgRoles(orgId: string, expected: { userId: string; role: string }[]) {
	const rows = await teamMemberships(orgId);
	expect(rows).toHaveLength(expected.length);
	expect(rows).toEqual(expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))));
}

/** Runs deleteUserRecords while capturing console.info succession messages, then restores the spy. */
async function deleteWithSuccessionLogs(userId: string) {
	const info = vi.spyOn(console, 'info').mockImplementation(() => {});
	try {
		await deleteUserRecords(userId);
		return info.mock.calls.map((call) => String(call[0]));
	} finally {
		info.mockRestore();
	}
}

test('deleteUserRecords removes only the membership when a plain member of a shared org leaves', async () => {
	// A plain member (not an owner) of a shared org with other members: the org,
	// its channels, and everyone else's roles are completely untouched — only
	// the departing user's membership row (and their personal tenancy) goes.
	const userId = await seedUser('gone');
	await seedBareUser('owner-stays');
	await seedBareUser('member-stays');
	await seedSharedOrg('org-team', [
		{ userId: 'owner-stays', role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
		{ userId: 'member-stays', role: 'member', joinedAt: '2026-01-02T00:00:00.000Z' },
		{ userId, role: 'member', joinedAt: '2026-01-03T00:00:00.000Z' }
	]);
	await seedChannel('UC-team', 'owner-stays', 'org-team', 'team channel');
	// A second team channel the departing user DID connect: the org survives, so
	// it must be detached (grant wiped), never deleted with the account.
	await seedChannel('UC-team-connected', userId, 'org-team', 'connected by leaver');

	await deleteUserRecords(userId);

	expect(await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-team')).all()).toHaveLength(1);
	await expectOrgRoles('org-team', [
		{ userId: 'owner-stays', role: 'owner' },
		{ userId: 'member-stays', role: 'member' }
	]);
	// The channel the user did NOT connect is byte-for-byte the team's.
	const team = (await testDb().db.select().from(channels).all()).find((c) => c.id === 'UC-team');
	expect(team).toMatchObject({ userId: 'owner-stays', refreshTokenEnc: 'enc' });
	// The channel the user DID connect stays with the team, grant wiped.
	const connected = (await testDb().db.select().from(channels).all()).find((c) => c.id === 'UC-team-connected');
	expect(connected).toMatchObject({ userId: null, refreshTokenEnc: WIPED_REFRESH_TOKEN });
});

test('deleteUserRecords promotes the oldest admin when the last owner of a shared org deletes their account', async () => {
	// Succession: deleting the sole owner must never leave a shared org
	// ownerless. The oldest ADMIN (by membership seniority) inherits ownership;
	// the org, its channels, and all other roles survive. Logged loudly.
	const userId = await seedUser('gone');
	await seedBareUser('admin-old');
	await seedBareUser('admin-new');
	await seedBareUser('member-1');
	await seedSharedOrg('org-team', [
		{ userId, role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
		{ userId: 'member-1', role: 'member', joinedAt: '2026-01-02T00:00:00.000Z' },
		{ userId: 'admin-old', role: 'admin', joinedAt: '2026-01-03T00:00:00.000Z' },
		{ userId: 'admin-new', role: 'admin', joinedAt: '2026-01-04T00:00:00.000Z' }
	]);
	await seedChannel('UC-team', 'admin-old', 'org-team', 'team channel');

	const logs = await deleteWithSuccessionLogs(userId);

	// Exactly one succession, and the log names WHO was promoted WHERE — a bare
	// "something was logged" assertion would pass on any unrelated info line.
	expect(logs).toHaveLength(1);
	expect(logs[0]).toContain('admin-old');
	expect(logs[0]).toContain('org-team');
	const remaining = await teamMemberships('org-team');
	expect(remaining).toHaveLength(3);
	// The OLDER admin wins — join order, not name order, decides.
	expect(remaining.find((m) => m.userId === 'admin-old')).toMatchObject({ role: 'owner' });
	expect(remaining.find((m) => m.userId === 'admin-new')).toMatchObject({ role: 'admin' });
	expect(remaining.find((m) => m.userId === 'member-1')).toMatchObject({ role: 'member' });
	// The org and its channel survive the succession.
	expect(await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-team')).all()).toHaveLength(1);
	expect((await testDb().db.select().from(channels).all()).find((c) => c.id === 'UC-team')).toBeDefined();
});

test('deleteUserRecords promotes the oldest member when a shared org has no admin left', async () => {
	// Succession fallback: no surviving admin → the oldest plain MEMBER inherits.
	const userId = await seedUser('gone');
	await seedBareUser('member-old');
	await seedBareUser('member-new');
	await seedSharedOrg('org-team', [
		{ userId, role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
		{ userId: 'member-old', role: 'member', joinedAt: '2026-01-02T00:00:00.000Z' },
		{ userId: 'member-new', role: 'member', joinedAt: '2026-01-03T00:00:00.000Z' }
	]);

	await deleteUserRecords(userId);

	const remaining = await teamMemberships('org-team');
	expect(remaining).toHaveLength(2);
	expect(remaining.find((m) => m.userId === 'member-old')).toMatchObject({ role: 'owner' });
	expect(remaining.find((m) => m.userId === 'member-new')).toMatchObject({ role: 'member' });
});

test('deleteUserRecords leaves roles untouched when another owner survives in a shared org', async () => {
	// No succession needed: a second owner remains, so nobody is promoted and
	// every surviving role is exactly what it was.
	const userId = await seedUser('gone');
	await seedBareUser('owner-stays');
	await seedBareUser('admin-stays');
	await seedBareUser('member-stays');
	await seedSharedOrg('org-team', [
		{ userId, role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
		{ userId: 'owner-stays', role: 'owner', joinedAt: '2026-01-02T00:00:00.000Z' },
		{ userId: 'admin-stays', role: 'admin', joinedAt: '2026-01-03T00:00:00.000Z' },
		{ userId: 'member-stays', role: 'member', joinedAt: '2026-01-04T00:00:00.000Z' }
	]);
	const logs = await deleteWithSuccessionLogs(userId);

	await expectOrgRoles('org-team', [
		{ userId: 'owner-stays', role: 'owner' },
		{ userId: 'admin-stays', role: 'admin' },
		{ userId: 'member-stays', role: 'member' }
	]);
	// No succession happened, so no succession was logged.
	expect(logs).toEqual([]);
});

test('deleteUserRecords dissolves a sole-member shared org with its channels and data', async () => {
	// A SHARED org whose only member is the deleting user has no one to survive
	// to: succession is impossible, so it dissolves exactly like a personal org —
	// channels, moderation history, rules, invites, memberships, and the org row.
	const userId = await seedUser('gone');
	await seedSharedOrg('org-solo', [{ userId, role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' }]);
	await testDb()
		.db.insert(invites)
		.values({ token: 'invite-solo', orgId: 'org-solo', role: 'member', createdBy: userId, expiresAt: new Date(Date.now() + DAY_MS).toISOString() });
	await seedChannel('UC-solo', userId, 'org-solo', 'solo team channel');
	await seedModerationData('UC-solo', 'solo');

	await deleteUserRecords(userId);

	// Both orgs (personal + sole-member shared) are gone with everything in them.
	await expectAllTablesEmpty();
	expect(await userRow(userId)).toMatchObject({ googleSub: `deleted:${userId}` });
});

test('deleteUserRecords logs no succession when the transaction rolls back', async () => {
	// Rollback boundary: succession is logged only AFTER commit. A trigger
	// forces the final tombstone UPDATE to abort, so the promotion rolls back
	// with everything else — if the log lived INSIDE the transaction it would
	// still fire, and this test would catch it.
	const userId = await seedUser('gone');
	await seedBareUser('admin-old');
	await seedSharedOrg('org-team', [
		{ userId, role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
		{ userId: 'admin-old', role: 'admin', joinedAt: '2026-01-02T00:00:00.000Z' }
	]);
	await testDb().client.execute("CREATE TRIGGER fail_tombstone BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, 'boom'); END");
	const info = vi.spyOn(console, 'info').mockImplementation(() => {});
	let logCount = 0;
	try {
		await expect(deleteUserRecords(userId)).rejects.toThrow();
		logCount = info.mock.calls.length;
	} finally {
		info.mockRestore();
		await testDb().client.execute('DROP TRIGGER fail_tombstone');
	}

	expect(logCount).toBe(0);
	// Everything rolled back: the promotion never persisted, no tombstone.
	expect((await teamMemberships('org-team')).find((m) => m.userId === 'admin-old')).toMatchObject({ role: 'admin' });
	expect(await userRow(userId)).toMatchObject({ googleSub: 'sub-gone' });
});

test('deleteUserRecords logs the inconsistent personal-org membership loudly before aborting', async () => {
	// The guard's console.error is part of the contract (fail loudly, AGENTS.md):
	// it must name the user and the exact inconsistent row count — an emptied
	// message would leave operators with a bare throw and no diagnosis.
	const userId = await seedUser('gone');
	await seedBareUser('member-2');
	await testDb().db.insert(memberships).values({ userId: 'member-2', orgId: 'org-gone', role: 'member' });
	const error = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		await expect(deleteUserRecords(userId)).rejects.toThrow('personal organization has other members');
		expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
			expect.stringContaining(`user ${userId}'s personal org membership is inconsistent (2 rows)`)
		]);
	} finally {
		error.mockRestore();
	}
	// Full rollback: the org, both memberships, and the user's identity survive.
	expect(await userRow(userId)).toMatchObject({ googleSub: 'sub-gone' });
	expect(await testDb().db.select().from(organizations).all()).toHaveLength(1);
	expect(await testDb().db.select().from(memberships).all()).toHaveLength(2);
});

test('deleteUserRecords breaks succession seniority ties by userId, not insertion order', async () => {
	// Both surviving members joined in the SAME instant: createdAt ties, so the
	// userId tie-break decides. Seeded in adversarial insertion order (zz first)
	// so a dropped sort, a no-op comparator, or a constant comparator all crown
	// the wrong successor.
	const userId = await seedUser('gone');
	await seedBareUser('zz-member');
	await seedBareUser('aa-member');
	await seedSharedOrg('org-team', [
		{ userId, role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
		{ userId: 'zz-member', role: 'member', joinedAt: '2026-01-02T00:00:00.000Z' },
		{ userId: 'aa-member', role: 'member', joinedAt: '2026-01-02T00:00:00.000Z' }
	]);

	const logs = await deleteWithSuccessionLogs(userId);

	expect(logs).toHaveLength(1);
	expect(logs[0]).toContain('aa-member');
	await expectOrgRoles('org-team', [
		{ userId: 'aa-member', role: 'owner' },
		{ userId: 'zz-member', role: 'member' }
	]);
});

test('deleteUserRecords fails loudly when the succession update matches no row', async () => {
	// The RETURNING-empty guard: the successor row was selected in this same
	// transaction, so an empty RETURNING means the data changed underneath —
	// simulated with a trigger that silently swallows the promotion UPDATE
	// (RAISE(IGNORE) skips the row action without erroring).
	const userId = await seedUser('gone');
	await seedBareUser('admin-old');
	await seedSharedOrg('org-team', [
		{ userId, role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
		{ userId: 'admin-old', role: 'admin', joinedAt: '2026-01-02T00:00:00.000Z' }
	]);
	await testDb().client.execute('CREATE TRIGGER swallow_promotion BEFORE UPDATE ON memberships BEGIN SELECT RAISE(IGNORE); END');
	const error = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		await expect(deleteUserRecords(userId)).rejects.toThrow('ownership succession failed — contact support');
		// The loud log names the vanished successor and the org.
		expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
			expect.stringContaining('successor admin-old vanished from org org-team')
		]);
	} finally {
		error.mockRestore();
		await testDb().client.execute('DROP TRIGGER swallow_promotion');
	}
	// Everything rolled back: no promotion, no tombstone, org intact.
	expect((await teamMemberships('org-team')).find((m) => m.userId === 'admin-old')).toMatchObject({ role: 'admin' });
	expect(await userRow(userId)).toMatchObject({ googleSub: 'sub-gone' });
});

test('deleteUserRecords refuses when the personal org has no membership row at all', async () => {
	// The COUNT half of the guard: personal_for points at an org the user has
	// NO membership in — deleting would orphan the org. `.some()` on an EMPTY
	// member list is vacuously false, so only the length mismatch catches this.
	const userId = await seedUser('gone');
	await testDb()
		.db.delete(memberships)
		.where(and(eq(memberships.userId, userId), eq(memberships.orgId, 'org-gone')));

	await expect(deleteUserRecords(userId)).rejects.toThrow('personal organization has other members');

	// Nothing was erased: no tombstone, the org and its channel survive.
	expect(await userRow(userId)).toMatchObject({ googleSub: 'sub-gone' });
	expect(await testDb().db.select().from(organizations).all()).toHaveLength(1);
	expect(await testDb().db.select().from(channels).all()).toHaveLength(1);
});

test('deleteUserRecords never promotes a successor when the departing user was not an owner', async () => {
	// Succession is owner-triggered ONLY: a plain member leaving an org that has
	// no owner (data bug) must change nothing but their own membership — never
	// crown a successor they had no authority to name.
	const userId = await seedUser('gone');
	await seedBareUser('alice');
	await seedBareUser('bob');
	await seedSharedOrg('org-team', [
		{ userId: 'alice', role: 'member', joinedAt: '2026-01-01T00:00:00.000Z' },
		{ userId: 'bob', role: 'member', joinedAt: '2026-01-02T00:00:00.000Z' },
		{ userId, role: 'member', joinedAt: '2026-01-03T00:00:00.000Z' }
	]);

	const logs = await deleteWithSuccessionLogs(userId);

	await expectOrgRoles('org-team', [
		{ userId: 'alice', role: 'member' },
		{ userId: 'bob', role: 'member' }
	]);
	expect(logs).toEqual([]);
});

test('nullExpiredConsentEmails erases only the e-mail of consents older than 10 years', async () => {
	await seedUser('old');
	const oldDate = new Date(Date.now() - CONSENT_EMAIL_RETENTION_MS - DAY_MS).toISOString();
	const recentDate = new Date(Date.now() - 30 * DAY_MS).toISOString();
	await seedConsent('old', oldDate);
	await seedConsent('old', recentDate);

	expect(await nullExpiredConsentEmails()).toBe(1);

	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toHaveLength(2);
	const old = rows.find((row) => row.createdAt === oldDate);
	const recent = rows.find((row) => row.createdAt === recentDate);
	// The ROW is kept as anonymized evidence; only the identifier is erased.
	expect(old).toMatchObject({ email: null, docVersion: 'v1.2', checkboxText: 'I agree' });
	expect(recent).toMatchObject({ email: 'old@example.com' });
});

test('nullExpiredConsentEmails is idempotent and returns 0 with nothing to do', async () => {
	await seedUser('recent');
	await seedConsent('recent');

	expect(await nullExpiredConsentEmails()).toBe(0);
	expect(await nullExpiredConsentEmails()).toBe(0);
});

test('nullExpiredConsentEmails skips already-erased rows instead of re-selecting them', async () => {
	// Mutation audit: dropping the isNotNull filter stayed green because no
	// test seeds an already-null expired row — no-op re-selections would fill
	// the bounded batch, delaying genuinely expired rows (retention compliance).
	const expired = new Date(Date.now() - CONSENT_EMAIL_RETENTION_MS - DAY_MS).toISOString();
	await seedBareUser('erased');
	await seedBareUser('pending');
	await seedConsent('erased', expired);
	await seedConsent('pending', expired);
	await testDb().db.update(consents).set({ email: null }).where(eq(consents.userId, 'erased'));

	expect(await nullExpiredConsentEmails()).toBe(1);
	expect((await testDb().db.select().from(consents).all()).find((row) => row.userId === 'pending')).toMatchObject({
		email: null
	});
});

test('nullExpiredConsentEmails is bounded to one batch per call (I10)', async () => {
	// Mutation audit: dropping .limit(CONSENT_SWEEP_BATCH) stayed green — an
	// unbounded sweep would blow the 20-second cron budget on a large backlog.
	const expired = new Date(Date.now() - CONSENT_EMAIL_RETENTION_MS - DAY_MS).toISOString();
	for (let index = 0; index < 51; index++) {
		await seedBareUser(`bulk-${index}`);
		await seedConsent(`bulk-${index}`, expired);
	}

	expect(await nullExpiredConsentEmails()).toBe(50); // CONSENT_SWEEP_BATCH
	// The remainder waits for the next cron invocation.
	expect(await nullExpiredConsentEmails()).toBe(1);
});

test('consentEmailCutoffIso lands 10 years back', () => {
	const now = Date.now();
	expect(Date.parse(consentEmailCutoffIso(now))).toBe(now - CONSENT_EMAIL_RETENTION_MS);
});
