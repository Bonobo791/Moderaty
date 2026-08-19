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

import { and, eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ customersDel: vi.fn(), customersUpdate: vi.fn() }));

vi.mock('$lib/server/stripe/client', () => ({
	getStripe: () => ({ customers: { del: mocks.customersDel, update: mocks.customersUpdate } })
}));

import { DAY_MS, seedConsent, seedUser as seedBareUser, setupTestDb, testDb } from './testdb';
import { auditLog, channelAllowedHandles, channels, comments, consents, creditTransactions, invites, memberships, moderationActions, organizations, rules, sessions, stripeDeletionOutbox, users } from './db/schema';
import {
	AUDIT_HANDLE_RETENTION_MS,
	CONSENT_EMAIL_RETENTION_MS,
	WIPED_REFRESH_TOKEN,
	auditHandleCutoffIso,
	consentEmailCutoffIso,
	deleteChannelRecords,
	deleteUserRecords,
	retryStripeCustomerDeletions,
	nullExpiredAuditLogHandles,
	nullExpiredConsentEmails,
	nullExpiredHandles,
	nullExpiredModerationActionHandles
} from './deletion';

setupTestDb(['moderation_actions', 'comments', 'audit_log', 'channel_allowed_handles', 'rules', 'channels', 'sessions', 'consents', 'invites', 'memberships', 'organizations', 'users', 'credit_transactions', 'stripe_deletion_outbox']);

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

test('deleteUserRecords erases protected handles on deleted channels but keeps other channels\' handles', async () => {
	// channel_allowed_handles rows are channel children: they die with the
	// deleted account's channels and survive on unrelated channels.
	const userId = await seedUser('gone');
	await seedUser('stays');
	await testDb().db.insert(channelAllowedHandles).values({ channelId: 'UC-gone', handle: '@friend' });
	await testDb().db.insert(channelAllowedHandles).values({ channelId: 'UC-stays', handle: '@mod' });

	await deleteUserRecords(userId);

	const surviving = await testDb().db.select().from(channelAllowedHandles).all();
	expect(surviving).toHaveLength(1);
	expect(surviving[0]).toMatchObject({ channelId: 'UC-stays', handle: '@mod' });
});

test('deleteChannelRecords erases protected handles with the channel', async () => {
	await seedChannel('UC1', 'user-9', 'org-1', 'ours');
	await testDb().db.insert(channelAllowedHandles).values({ channelId: 'UC1', handle: '@friend' });

	await testDb().db.transaction(async (tx) => {
		await deleteChannelRecords(tx, ['UC1'], { expectedOrgId: 'org-1' });
	});

	expect(await testDb().db.select().from(channelAllowedHandles).all()).toHaveLength(0);
});

/** Seeds a channel row with the standard shape (placeholder enc token). */
async function seedChannel(id: string, userId: string | null, orgId: string, title: string) {
	await testDb().db.insert(channels).values({ id, userId, orgId, title, refreshTokenEnc: 'enc' });
}

// PR #123 review (codeant): the disconnect action authorizes with a SELECT,
// then deletes in a separate transaction — a channel reconnected under a
// DIFFERENT org in between must not be erased across the tenancy boundary.
test('deleteChannelRecords with an expected org aborts loudly when the channel changed tenancy mid-request', async () => {
	await seedChannel('UC1', 'user-9', 'org-2', 'foreign channel');
	await seedModerationData('UC1', 'race');

	await expect(
		testDb().db.transaction(async (tx) => {
			await deleteChannelRecords(tx, ['UC1'], { expectedOrgId: 'org-1' });
		})
	).rejects.toThrow('deleteChannelRecords: channel tenancy changed mid-request — aborting');

	// The transaction rolled back: the channel and every row it owns survive.
	expect(await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).all()).toHaveLength(1);
	expect(await testDb().db.select().from(comments).where(eq(comments.channelId, 'UC1')).all()).toHaveLength(1);
	expect(await testDb().db.select().from(rules).where(eq(rules.channelId, 'UC1')).all()).toHaveLength(1);
});

test('deleteChannelRecords with a matching expected org erases the channel and its data', async () => {
	await seedChannel('UC1', 'user-9', 'org-1', 'ours');
	await seedModerationData('UC1', 'match');

	await testDb().db.transaction(async (tx) => {
		await deleteChannelRecords(tx, ['UC1'], { expectedOrgId: 'org-1' });
	});

	expect(await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).all()).toHaveLength(0);
	expect(await testDb().db.select().from(comments).where(eq(comments.channelId, 'UC1')).all()).toHaveLength(0);
	expect(await testDb().db.select().from(rules).where(eq(rules.channelId, 'UC1')).all()).toHaveLength(0);
});

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

	test('deleteUserRecords erases the dissolved orgs\' Stripe customers', async () => {
		// The Stripe Customer holds the org's name and the saved card used for
		// off-session auto top-up — "immediate and permanent" deletion must
		// erase it at Stripe too, not just the local row.
		const userId = await seedUser('gone');
		await testDb().db.update(organizations).set({ stripeCustomerId: 'cus_gone', stripeDefaultPmId: 'pm_gone' }).where(eq(organizations.id, 'org-gone'));
		mocks.customersDel.mockResolvedValue({ id: 'cus_gone', deleted: true });

		await deleteUserRecords(userId);

		expect(mocks.customersDel).toHaveBeenCalledWith('cus_gone');
		// The outbox row existed only for the retry path — a confirmed deletion
		// clears it, so the cron never re-deletes a gone customer.
		expect(await testDb().db.select().from(stripeDeletionOutbox).all()).toEqual([]);
	});

	test('a Stripe customer deletion failure is loud but never blocks the account deletion', async () => {
		const userId = await seedUser('gone');
		await testDb().db.update(organizations).set({ stripeCustomerId: 'cus_gone' }).where(eq(organizations.id, 'org-gone'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.customersDel.mockRejectedValue(new Error('stripe is down'));

		await expect(deleteUserRecords(userId)).resolves.toBeUndefined();
		// The deletion completed: the tombstone is written even though the
		// Stripe erasure failed (privacy is not held hostage by Stripe uptime).
		expect(await userRow(userId)).toMatchObject({ googleSub: `deleted:${userId}` });
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('cus_gone'));
		errorSpy.mockRestore();
	});

test('permanently failing deletion rows rotate behind newer work — never starve later obligations', async () => {
	// The outbox always selected the OLDEST ten rows: ten permanently failing
	// rows (e.g. an object from the wrong Stripe mode after a credential
	// change) would occupy the whole bounded batch forever and every later
	// account-deletion obligation would never be attempted (codex review).
	const now = Date.now();
	for (let i = 1; i <= 10; i++) {
		await testDb().db.insert(stripeDeletionOutbox).values({
			customerId: `cus_fail_${i}`,
			createdAt: new Date(now - (11 - i) * 1000).toISOString()
		});
	}
	await testDb().db.insert(stripeDeletionOutbox).values({ customerId: 'cus_new_1', createdAt: new Date(now).toISOString() });
	await testDb().db.insert(stripeDeletionOutbox).values({ customerId: 'cus_new_2', createdAt: new Date(now + 1000).toISOString() });

	const attempted: string[] = [];
	mocks.customersDel.mockImplementation(async (id: string) => {
		attempted.push(id);
		if (id.startsWith('cus_fail_')) throw new Error('stripe: no such customer (wrong mode)');
		return { id, deleted: true };
	});
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		await retryStripeCustomerDeletions(10);
		await retryStripeCustomerDeletions(10);

		// The two NEVER-attempted newer obligations were reached on the second
		// run — the failing batch rotated behind them.
		expect(attempted).toContain('cus_new_1');
		expect(attempted).toContain('cus_new_2');
	} finally {
		errorSpy.mockRestore();
	}
});

test('a recently-retried failing row waits out the backoff before its next attempt', async () => {
	// Backoff: a row retried one minute ago is not hammered again this run —
	// the bounded batch stays available for rows that are actually due.
	await testDb().db.insert(stripeDeletionOutbox).values({
		customerId: 'cus_warm',
		attempts: 1,
		lastAttemptAt: new Date(Date.now() - 60 * 1000).toISOString()
	});
	await testDb().db.insert(stripeDeletionOutbox).values({ customerId: 'cus_due', createdAt: new Date(Date.now() - 5000).toISOString() });
	mocks.customersDel.mockResolvedValue({ id: 'x', deleted: true });
	mocks.customersDel.mockClear();

	const deleted = await retryStripeCustomerDeletions(10);

	expect(deleted).toBe(1); // only the due row
	expect(mocks.customersDel).toHaveBeenCalledWith('cus_due');
	expect(mocks.customersDel).not.toHaveBeenCalledWith('cus_warm');
});

test('the deletion outbox retry respects a shared cron deadline', async () => {
	// The cron budget is shared with moderation: ten sequential Stripe
	// deletions with SDK retries can eat the whole serverless window before a
	// channel is even claimed (codex review).
	await testDb().db.insert(stripeDeletionOutbox).values({ customerId: 'cus_1' });
	mocks.customersDel.mockClear();

	const deleted = await retryStripeCustomerDeletions(10, Date.now() - 1000);

	expect(deleted).toBe(0);
	expect(mocks.customersDel).not.toHaveBeenCalled();
});

test('each Stripe deletion request is capped to the remaining cron deadline', async () => {
	// The pre-request guard alone does not constrain the remote call: the
	// shared Stripe client performs up to two network retries, so a hanging
	// request can blow past the 20s cron budget and get killed before
	// lastAttemptAt is recorded (human review). Each customers.del must carry
	// a timeout derived from the remaining deadline.
	await testDb().db.insert(stripeDeletionOutbox).values({ customerId: 'cus_deadline' });
	mocks.customersDel.mockClear();
	mocks.customersDel.mockResolvedValue({ id: 'cus_deadline', deleted: true });

	await retryStripeCustomerDeletions(10, Date.now() + 10_000);

	expect(mocks.customersDel).toHaveBeenCalledWith('cus_deadline', { timeout: expect.any(Number) });
});


test('a failed Stripe customer deletion is persisted to the outbox for cron retry', async () => {
	// "Immediate and permanent" deletion must not lose the erasure to a
	// transient Stripe outage: the outbox row carries the obligation and the
	// cron retries it until Stripe confirms (coderabbit).
	const userId = await seedUser('gone');
	await testDb().db.update(organizations).set({ stripeCustomerId: 'cus_gone' }).where(eq(organizations.id, 'org-gone'));
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	mocks.customersDel.mockRejectedValue(new Error('stripe is down'));
	try {
		await deleteUserRecords(userId);

		// The deletion completed locally; the erasure obligation survives.
		expect(await userRow(userId)).toMatchObject({ googleSub: `deleted:${userId}` });
		const outbox = await testDb().db.select().from(stripeDeletionOutbox).all();
		expect(outbox).toHaveLength(1);
		expect(outbox[0]).toMatchObject({ customerId: 'cus_gone', attempts: 0 });

		// The cron retry succeeds and clears the row.
		mocks.customersDel.mockResolvedValue({ id: 'cus_gone', deleted: true });
		expect(await retryStripeCustomerDeletions()).toBe(1);
		expect(await testDb().db.select().from(stripeDeletionOutbox).all()).toEqual([]);
	} finally {
		errorSpy.mockRestore();
	}
});

test('deleteUserRecords anonymizes the Stripe customer of a surviving team org whose last owner leaves', async () => {
	// The org survives (a co-member is promoted to owner), but its Stripe
	// Customer was created with the DEPARTING user's e-mail and holds their
	// saved payment method — that PII must not outlive the account
	// (codex 6151). The customer itself stays: the org keeps billing.
	const userId = await seedUser('departing');
	const coMember = await seedBareUser('staying');
	await testDb().db.insert(organizations).values({ id: 'org-shared', name: 'Shared', stripeCustomerId: 'cus_shared', stripeDefaultPmId: 'pm_shared' });
	await testDb().db.insert(memberships).values({ userId, orgId: 'org-shared', role: 'owner' });
	await testDb().db.insert(memberships).values({ userId: coMember, orgId: 'org-shared', role: 'member' });
	mocks.customersUpdate.mockResolvedValue({ id: 'cus_shared' });

	await deleteUserRecords(userId);

	expect(mocks.customersUpdate).toHaveBeenCalledWith('cus_shared', expect.objectContaining({ email: '' }));
	// The org and its customer survive for the promoted successor.
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-shared')).get();
	expect(org?.stripeCustomerId).toBe('cus_shared');
	// The surviving org's customer is never deleted.
	expect(mocks.customersDel).not.toHaveBeenCalledWith('cus_shared');
});

test('deleteUserRecords scrubs the Stripe email even when the departing user was NOT the last owner (no promotion)', async () => {
	// The checkout flow lets ANY owner create the team's Stripe customer —
	// "last owner leaves" (promotion) is an unreliable proxy for whose PII the
	// customer holds. A departing owner whose co-owner stays must still have
	// their e-mail scrubbed from the surviving org's customer (codex review).
	const userId = await seedUser('departing');
	const coOwner = await seedBareUser('staying');
	await testDb().db.insert(organizations).values({ id: 'org-shared', name: 'Shared', stripeCustomerId: 'cus_shared', stripeDefaultPmId: 'pm_shared' });
	await testDb().db.insert(memberships).values({ userId, orgId: 'org-shared', role: 'owner' });
	await testDb().db.insert(memberships).values({ userId: coOwner, orgId: 'org-shared', role: 'owner' });
	// This file has no per-test mock reset — clear so the assertion is local.
	mocks.customersUpdate.mockClear();
	mocks.customersDel.mockClear();
	mocks.customersUpdate.mockResolvedValue({ id: 'cus_shared' });

	await deleteUserRecords(userId);

	expect(mocks.customersUpdate).toHaveBeenCalledWith('cus_shared', expect.objectContaining({ email: '' }));
	// The org (with another owner) survives; its customer is never deleted.
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-shared')).get();
	expect(org?.stripeCustomerId).toBe('cus_shared');
	expect(mocks.customersDel).not.toHaveBeenCalledWith('cus_shared');
});
test('deleteUserRecords erases the dissolved orgs\' credit ledger rows', async () => {
	const userId = await seedUser('gone');
	// The org bought credits (purchase + consumption rows) — the ledger is
	// part of the org's records and must die with it: an account deletion
	// declared "immediate and permanent" cannot leave comment/checkout/PI ids
	// behind in orphaned credit_transactions rows.
	await testDb().db.insert(creditTransactions).values([
		{ orgId: 'org-gone', delta: 500, reason: 'purchase', refType: 'checkout_session', refId: 'cs_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' },
		{ orgId: 'org-gone', delta: -1, reason: 'consume', refType: 'comment', refId: 'comment-1' }
	]);

	await deleteUserRecords(userId);

	expect(await testDb().db.select().from(creditTransactions).all()).toEqual([]);
});

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

/** Seeds one audit row with a stored commenter handle at `createdAt`. */
async function seedHandledAuditRow(commentId: string, createdAt: string, authorHandle: string | null = '@some.user') {
	await testDb().db.insert(auditLog).values({
		channelId: 'UC1',
		commentId,
		action: 'reject',
		reason: 'ai score 0.91',
		actor: 'system',
		authorHandle,
		createdAt
	});
}

test('nullExpiredAuditLogHandles erases only the handle of audit rows older than 30 days', async () => {
	const oldDate = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	const recentDate = new Date(Date.now() - DAY_MS).toISOString();
	await seedHandledAuditRow('old', oldDate, '@old.user');
	await seedHandledAuditRow('recent', recentDate, '@recent.user');

	expect(await nullExpiredAuditLogHandles()).toBe(1);

	const rows = await testDb().db.select().from(auditLog).all();
	expect(rows).toHaveLength(2);
	// The ROW is kept as the moderation record; only the identifier is erased.
	expect(rows.find((row) => row.commentId === 'old')).toMatchObject({ authorHandle: null, action: 'reject' });
	expect(rows.find((row) => row.commentId === 'recent')).toMatchObject({ authorHandle: '@recent.user' });
});

test('nullExpiredAuditLogHandles leaves every other column byte-identical', async () => {
	const oldDate = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	await seedHandledAuditRow('c1', oldDate, '@some.user');
	const before = (await testDb().db.select().from(auditLog).all())[0];

	await nullExpiredAuditLogHandles();

	const after = (await testDb().db.select().from(auditLog).all())[0];
	expect(after.authorHandle).toBeNull();
	// Restoring the handle must reproduce the pre-sweep row exactly.
	expect({ ...after, authorHandle: before.authorHandle }).toEqual(before);
});

test('nullExpiredAuditLogHandles skips rows whose handle is already erased', async () => {
	// Mirror of the consent-sweep pin: dropping the isNotNull filter lets
	// already-erased rows fill the bounded batch, delaying genuinely expired
	// rows (retention compliance).
	const expired = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	await seedHandledAuditRow('erased', expired, null);
	await seedHandledAuditRow('pending', expired, '@pending.user');

	expect(await nullExpiredAuditLogHandles()).toBe(1);
	expect((await testDb().db.select().from(auditLog).all()).find((row) => row.commentId === 'pending')).toMatchObject({
		authorHandle: null
	});
});

test('nullExpiredAuditLogHandles is bounded to one batch per call (I10)', async () => {
	// Mirror of the consent-sweep pin: an unbounded sweep would blow the
	// 20-second cron budget on a large backlog.
	const expired = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	for (let index = 0; index < 51; index++) {
		await seedHandledAuditRow(`bulk-${index}`, expired, `@user${index}`);
	}

	expect(await nullExpiredAuditLogHandles()).toBe(50);
	// The remainder waits for the next cron invocation.
	expect(await nullExpiredAuditLogHandles()).toBe(1);
});

test('nullExpiredAuditLogHandles is idempotent: a second call after a full drain nulls nothing', async () => {
	const expired = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	await seedHandledAuditRow('a', expired);
	await seedHandledAuditRow('b', expired);

	expect(await nullExpiredAuditLogHandles()).toBe(2);
	expect(await nullExpiredAuditLogHandles()).toBe(0);
});

test('nullExpiredAuditLogHandles returns 0 with nothing to do', async () => {
	await seedHandledAuditRow('recent', new Date().toISOString());

	expect(await nullExpiredAuditLogHandles()).toBe(0);
});

test('auditHandleCutoffIso lands 30 days back', () => {
	const now = Date.now();
	expect(Date.parse(auditHandleCutoffIso(now))).toBe(now - AUDIT_HANDLE_RETENTION_MS);
});

/** Seeds one moderation action row with a stored commenter handle at `createdAt`. */
async function seedHandledActionRow(commentId: string, createdAt: string, authorHandle: string | null = '@some.user') {
	await testDb().db.insert(moderationActions).values({
		commentId,
		channelId: 'UC1',
		action: 'ban',
		reason: 'rule #1 (user: troll)',
		state: 'completed',
		authorHandle,
		createdAt
	});
}

test('nullExpiredModerationActionHandles erases only the handle of action rows older than 30 days', async () => {
	const oldDate = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	const recentDate = new Date(Date.now() - DAY_MS).toISOString();
	await seedHandledActionRow('old', oldDate, '@old.user');
	await seedHandledActionRow('recent', recentDate, '@recent.user');

	expect(await nullExpiredModerationActionHandles()).toBe(1);

	const rows = await testDb().db.select().from(moderationActions).all();
	expect(rows).toHaveLength(2);
	// The ROW is kept as the enforcement record; only the identifier is erased.
	expect(rows.find((row) => row.commentId === 'old')).toMatchObject({ authorHandle: null, action: 'ban' });
	expect(rows.find((row) => row.commentId === 'recent')).toMatchObject({ authorHandle: '@recent.user' });
});

test('nullExpiredModerationActionHandles leaves every other column byte-identical', async () => {
	const oldDate = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	await seedHandledActionRow('c1', oldDate, '@some.user');
	const before = (await testDb().db.select().from(moderationActions).all())[0];

	await nullExpiredModerationActionHandles();

	const after = (await testDb().db.select().from(moderationActions).all())[0];
	expect(after.authorHandle).toBeNull();
	// Restoring the handle must reproduce the pre-sweep row exactly.
	expect({ ...after, authorHandle: before.authorHandle }).toEqual(before);
});

test('nullExpiredModerationActionHandles skips rows whose handle is already erased', async () => {
	// Mirror of the audit-log pin: dropping the isNotNull filter lets
	// already-erased rows fill the bounded batch, delaying genuinely expired
	// rows (retention compliance).
	const expired = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	await seedHandledActionRow('erased', expired, null);
	await seedHandledActionRow('pending', expired, '@pending.user');

	expect(await nullExpiredModerationActionHandles()).toBe(1);
	expect((await testDb().db.select().from(moderationActions).all()).find((row) => row.commentId === 'pending')).toMatchObject({
		authorHandle: null
	});
});

test('nullExpiredModerationActionHandles is bounded to one batch per call (I10)', async () => {
	// Mirror of the audit-log pin: an unbounded sweep would blow the
	// 20-second cron budget on a large backlog.
	const expired = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	for (let index = 0; index < 51; index++) {
		await seedHandledActionRow(`bulk-${index}`, expired, `@user${index}`);
	}

	expect(await nullExpiredModerationActionHandles()).toBe(50);
	// The remainder waits for the next cron invocation.
	expect(await nullExpiredModerationActionHandles()).toBe(1);
});

test('nullExpiredModerationActionHandles is idempotent: a second call after a full drain nulls nothing', async () => {
	const expired = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	await seedHandledActionRow('a', expired);
	await seedHandledActionRow('b', expired);

	expect(await nullExpiredModerationActionHandles()).toBe(2);
	expect(await nullExpiredModerationActionHandles()).toBe(0);
});

test('nullExpiredModerationActionHandles returns 0 with nothing to do', async () => {
	await seedHandledActionRow('recent', new Date().toISOString());

	expect(await nullExpiredModerationActionHandles()).toBe(0);
});

test('nullExpiredHandles sweeps both handle-bearing tables and reports each count', async () => {
	const expired = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	await seedHandledAuditRow('audit-old', expired);
	await seedHandledAuditRow('audit-recent', new Date().toISOString());
	await seedHandledActionRow('action-old-1', expired);
	await seedHandledActionRow('action-old-2', expired);

	expect(await nullExpiredHandles()).toEqual({ auditLog: 1, moderationActions: 2 });

	expect((await testDb().db.select().from(auditLog).all()).find((row) => row.commentId === 'audit-old')).toMatchObject({
		authorHandle: null
	});
	const actions = await testDb().db.select().from(moderationActions).all();
	expect(actions.every((row) => row.authorHandle === null)).toBe(true);
});
