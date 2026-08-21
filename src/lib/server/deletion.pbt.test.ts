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

import fc from 'fast-check';
import { expect, test, vi } from 'vitest';

import { setupTestDb, testDb, wipeTables } from './testdb';
import { auditLog, channels, comments, consents, invites, memberships, moderationActions, organizations, rules, sessions, users } from './db/schema';
import { CONSENT_EMAIL_RETENTION_MS, WIPED_REFRESH_TOKEN, deleteUserRecords, nullExpiredConsentEmails } from './deletion';
import {
	COMMENT_DECIDERS,
	COMMENT_STATUSES,
	RULE_ACTIONS,
	RULE_TYPES,
	commentTextArb,
	idArb,
	isoTimestampArb,
	orgGraphArb,
	toIso,
	type OrgGraphMembership
} from './testarbitraries';

const WIPE = [
	'moderation_actions',
	'comments',
	'audit_log',
	'rules',
	'channels',
	'sessions',
	'consents',
	'invites',
	'memberships',
	'organizations',
	'users'
];

setupTestDb(WIPE);

/** orgGraphArb membership (user, org) pairs are not unique — keep the first per pair (the table's composite PK). */
function dedupeMemberships(list: OrgGraphMembership[]): OrgGraphMembership[] {
	const seen = new Set<string>();
	return list.filter((membership) => {
		const key = `${membership.user.id}|${membership.org.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Per-user consent evidence fields (the rows deletion must never touch). */
const consentExtraArb = fc.record({
	docVersion: fc.string({ minLength: 1, maxLength: 12 }),
	checkboxText: fc.string({ minLength: 1, maxLength: 60 }),
	ip: fc.string({ minLength: 1, maxLength: 40 }),
	userAgent: fc.string({ minLength: 1, maxLength: 40 }),
	createdAt: isoTimestampArb
});

/** Per-channel moderation payload: one comment plus its action, audit row, and rule. */
const channelExtraArb = fc.record({
	commentText: commentTextArb,
	publishedAt: isoTimestampArb,
	status: fc.constantFrom(...COMMENT_STATUSES),
	decidedBy: fc.constantFrom(...COMMENT_DECIDERS),
	ruleType: fc.constantFrom(...RULE_TYPES),
	rulePattern: fc.string({ minLength: 1, maxLength: 20 }),
	ruleAction: fc.constantFrom(...RULE_ACTIONS),
	reason: fc.string({ minLength: 1, maxLength: 40 }),
	auditText: fc.option(commentTextArb, { nil: null })
});

const graphRunArb = orgGraphArb.chain((graph) => {
	const deduped = dedupeMemberships(graph.membership);
	// The deletion target must be a user with at least one membership.
	const memberUserIds = [...new Set(deduped.map((membership) => membership.user.id))];
	return fc.record({
		graph: fc.constant(graph),
		memberships: fc.constant(deduped),
		joinTimes: fc.array(isoTimestampArb, { minLength: deduped.length, maxLength: deduped.length }),
		consentExtras: fc.array(consentExtraArb, { minLength: graph.user.length, maxLength: graph.user.length }),
		channelExtras: fc.array(channelExtraArb, { minLength: graph.channel.length, maxLength: graph.channel.length }),
		inviteCreators: fc.array(fc.nat(), { minLength: graph.org.length, maxLength: graph.org.length }),
		inviteExpiry: fc.array(isoTimestampArb, { minLength: graph.org.length, maxLength: graph.org.length }),
		targetUserId: fc.constantFrom(...memberUserIds)
	});
});

type GraphRun = typeof graphRunArb extends fc.Arbitrary<infer T> ? T : never;

type Snapshot = {
	[K in 'users' | 'organizations' | 'memberships' | 'channels' | 'sessions' | 'consents' | 'invites' | 'comments' | 'moderationActions' | 'auditLog' | 'rules']: Awaited<
		ReturnType<typeof snapshotAll>
	>[K];
};

/** Reads every row of every tenancy/moderation table. */
async function snapshotAll() {
	const db = testDb().db;
	return {
		users: await db.select().from(users).all(),
		organizations: await db.select().from(organizations).all(),
		memberships: await db.select().from(memberships).all(),
		channels: await db.select().from(channels).all(),
		sessions: await db.select().from(sessions).all(),
		consents: await db.select().from(consents).all(),
		invites: await db.select().from(invites).all(),
		comments: await db.select().from(comments).all(),
		moderationActions: await db.select().from(moderationActions).all(),
		auditLog: await db.select().from(auditLog).all(),
		rules: await db.select().from(rules).all()
	};
}

function sortBy<T>(rows: T[], key: (row: T) => string | number): T[] {
	return [...rows].sort((x, y) => {
		const kx = key(x);
		const ky = key(y);
		return kx < ky ? -1 : kx > ky ? 1 : 0;
	});
}

/**
 * Oracle for the full post-deletion database state, computed from the
 * before-snapshot: U tombstoned; U's sessions/memberships/created invites
 * gone; sole-member orgs dissolved with their channels and channel-owned rows;
 * channels U connected in surviving orgs detached (token wiped); ownership
 * succession in surviving orgs where U was the last owner; every other row —
 * including ALL consents — byte-identical.
 */
function expectedAfterDeletion(before: Snapshot, targetUserId: string): Snapshot {
	const targetOrgIds = before.memberships.filter((m) => m.userId === targetUserId).map((m) => m.orgId);
	const dissolvedOrgIds = new Set(
		targetOrgIds.filter((orgId) => !before.memberships.some((m) => m.orgId === orgId && m.userId !== targetUserId))
	);
	// Succession: U was the last owner of a surviving org → the oldest admin
	// (else oldest member; join time, then userId) is promoted to owner.
	const promoted = new Set<string>();
	for (const orgId of targetOrgIds) {
		if (dissolvedOrgIds.has(orgId)) continue;
		const departing = before.memberships.find((m) => m.orgId === orgId && m.userId === targetUserId);
		const others = before.memberships.filter((m) => m.orgId === orgId && m.userId !== targetUserId);
		if (departing?.role !== 'owner' || others.some((m) => m.role === 'owner')) continue;
		const ranked = [...others].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.userId.localeCompare(y.userId));
		const successor = ranked.find((m) => m.role === 'admin') ?? ranked[0];
		promoted.add(`${successor.userId}|${orgId}`);
	}
	const deletedChannelIds = new Set(
		before.channels.filter((c) => c.orgId !== null && dissolvedOrgIds.has(c.orgId)).map((c) => c.id)
	);
	return {
		users: before.users.map((row) =>
			row.id === targetUserId
				? { ...row, googleSub: `deleted:${targetUserId}`, email: '[deleted]', displayName: '[deleted]' }
				: row
		),
		organizations: before.organizations.filter((row) => !dissolvedOrgIds.has(row.id)),
		memberships: before.memberships
			.filter((row) => row.userId !== targetUserId && !dissolvedOrgIds.has(row.orgId))
			.map((row) => (promoted.has(`${row.userId}|${row.orgId}`) ? { ...row, role: 'owner' } : row)),
		channels: before.channels
			.filter((row) => !(row.orgId !== null && dissolvedOrgIds.has(row.orgId)))
			.map((row) =>
				row.userId === targetUserId ? { ...row, userId: null, refreshTokenEnc: WIPED_REFRESH_TOKEN } : row
			),
		sessions: before.sessions.filter((row) => row.userId !== targetUserId),
		consents: before.consents, // statutory retention: never touched by account deletion
		invites: before.invites.filter((row) => !dissolvedOrgIds.has(row.orgId) && row.createdBy !== targetUserId),
		comments: before.comments.filter((row) => !deletedChannelIds.has(row.channelId)),
		moderationActions: before.moderationActions.filter((row) => !deletedChannelIds.has(row.channelId)),
		auditLog: before.auditLog.filter((row) => !deletedChannelIds.has(row.channelId)),
		rules: before.rules.filter((row) => !deletedChannelIds.has(row.channelId))
	};
}

/** Seeds the generated tenant graph (batched inserts; graph pools guarantee non-empty arrays). */
async function seedGraph(run: GraphRun): Promise<void> {
	const db = testDb().db;
	const { graph } = run;
	await db.insert(users).values(
		graph.user.map((user) => ({ id: user.id, googleSub: user.googleSub, email: user.email, displayName: user.displayName }))
	);
	await db.insert(organizations).values(graph.org.map((org) => ({ id: org.id, name: org.name })));
	await db.insert(memberships).values(
		run.memberships.map((membership, index) => ({
			userId: membership.user.id,
			orgId: membership.org.id,
			role: membership.role,
			createdAt: run.joinTimes[index]
		}))
	);
	await db.insert(channels).values(
		graph.channel.map((channel) => ({
			id: channel.id,
			userId: channel.connectedBy?.id ?? null,
			orgId: channel.org.id,
			title: channel.title,
			refreshTokenEnc: channel.refreshTokenEnc
		}))
	);
	// Moderation payload per channel — dissolving an org must take all of it.
	await db.insert(comments).values(
		graph.channel.map((channel, index) => ({
			id: `${channel.id}-comment`,
			channelId: channel.id,
			text: run.channelExtras[index].commentText,
			publishedAt: run.channelExtras[index].publishedAt,
			status: run.channelExtras[index].status,
			decidedBy: run.channelExtras[index].decidedBy
		}))
	);
	await db.insert(moderationActions).values(
		graph.channel.map((channel, index) => ({
			commentId: `${channel.id}-comment`,
			channelId: channel.id,
			action: 'delete',
			reason: run.channelExtras[index].reason,
			state: 'completed'
		}))
	);
	await db.insert(auditLog).values(
		graph.channel.map((channel, index) => ({
			channelId: channel.id,
			commentId: `${channel.id}-comment`,
			action: 'delete',
			reason: run.channelExtras[index].reason,
			actor: 'system',
			text: run.channelExtras[index].auditText
		}))
	);
	await db.insert(rules).values(
		graph.channel.map((channel, index) => ({
			channelId: channel.id,
			type: run.channelExtras[index].ruleType,
			pattern: run.channelExtras[index].rulePattern,
			action: run.channelExtras[index].ruleAction
		}))
	);
	const sessionExpiry = toIso(Date.now() + 30 * 24 * 60 * 60 * 1000);
	await db.insert(sessions).values(graph.user.map((user) => ({ id: `sess-${user.id}`, userId: user.id, expiresAt: sessionExpiry })));
	await db.insert(consents).values(
		graph.user.map((user, index) => ({ userId: user.id, email: user.email, ...run.consentExtras[index] }))
	);
	await db.insert(invites).values(
		graph.org.map((org, index) => ({
			token: `inv-${org.id}`,
			orgId: org.id,
			role: 'member',
			createdBy: graph.user[run.inviteCreators[index] % graph.user.length].id,
			expiresAt: run.inviteExpiry[index]
		}))
	);
}

test('conservation: deleteUserRecords erases exactly the target user\'s tenancy across generated org graphs', async () => {
	// Property audit: dropping any single delete (sessions, created invites,
	// memberships, dissolved-org channels or their comments/audit/rules),
	// skipping the detach UPDATE (userId/token), tombstoning the wrong users
	// fields, dissolving a SURVIVING org, or dropping the succession promotion
	// each flips a whole-table comparison red. Any write to consents breaks the
	// consents byte-identity assertion. Rows with no connection to U are pinned
	// byte-identical by the same comparisons (other-tenant isolation).
	const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {}); // succession logs
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		await fc.assert(
			fc.asyncProperty(graphRunArb, async (run) => {
				await wipeTables(WIPE); // fresh state per run, not per test
				await seedGraph(run);
				const before = await snapshotAll();

				await deleteUserRecords(run.targetUserId);

				// A well-formed graph never trips a data-bug guard: nothing loud.
				expect(errorSpy.mock.calls).toEqual([]);
				const after = await snapshotAll();
				const expected = expectedAfterDeletion(before, run.targetUserId);
				expect(sortBy(after.users, (row) => row.id)).toEqual(sortBy(expected.users, (row) => row.id));
				expect(sortBy(after.organizations, (row) => row.id)).toEqual(sortBy(expected.organizations, (row) => row.id));
				expect(sortBy(after.memberships, (row) => `${row.userId}|${row.orgId}`)).toEqual(
					sortBy(expected.memberships, (row) => `${row.userId}|${row.orgId}`)
				);
				expect(sortBy(after.channels, (row) => row.id)).toEqual(sortBy(expected.channels, (row) => row.id));
				expect(sortBy(after.sessions, (row) => row.id)).toEqual(sortBy(expected.sessions, (row) => row.id));
				expect(sortBy(after.consents, (row) => row.id)).toEqual(sortBy(expected.consents, (row) => row.id));
				expect(sortBy(after.invites, (row) => row.token)).toEqual(sortBy(expected.invites, (row) => row.token));
				expect(sortBy(after.comments, (row) => row.id)).toEqual(sortBy(expected.comments, (row) => row.id));
				expect(sortBy(after.moderationActions, (row) => row.commentId)).toEqual(
					sortBy(expected.moderationActions, (row) => row.commentId)
				);
				expect(sortBy(after.auditLog, (row) => row.id)).toEqual(sortBy(expected.auditLog, (row) => row.id));
				expect(sortBy(after.rules, (row) => row.id)).toEqual(sortBy(expected.rules, (row) => row.id));
			})
		);
	} finally {
		infoSpy.mockRestore();
		errorSpy.mockRestore();
	}
});

// ---------------------------------------------------------------------------
// nullExpiredConsentEmails
// ---------------------------------------------------------------------------

// Guard band around the 10-year cutoff: the milliseconds that pass between
// seeding and the sweep can never flip a row into the neighboring zone.
const GUARD_MS = 60_000;

interface SweepRow {
	zone: 'over' | 'under';
	ageMs: number;
	email: string;
	docVersion: string;
	checkboxText: string;
	ip: string;
	userAgent: string;
}

/** Consent rows with ages strictly on one side of the cutoff (guard-banded by construction). */
function sweepRowArb(zone: 'over' | 'under'): fc.Arbitrary<SweepRow> {
	return fc.record({
		zone: fc.constant(zone),
		ageMs:
			zone === 'over'
				? fc.integer({ min: CONSENT_EMAIL_RETENTION_MS + GUARD_MS, max: 2 * CONSENT_EMAIL_RETENTION_MS })
				: fc.integer({ min: GUARD_MS, max: CONSENT_EMAIL_RETENTION_MS - GUARD_MS }),
		email: idArb.map((id) => `${id}@example.com`),
		docVersion: fc.string({ minLength: 1, maxLength: 12 }),
		checkboxText: fc.string({ minLength: 1, maxLength: 60 }),
		ip: fc.string({ minLength: 1, maxLength: 40 }),
		userAgent: fc.string({ minLength: 1, maxLength: 30 })
	});
}

// ≤40 expired rows per run: everything fits in one 50-row batch, so the zone
// assertions stay exact. The >50 bound is covered by the dedicated property below.
const sweepArb = fc.tuple(
	fc.array(sweepRowArb('over'), { minLength: 1, maxLength: 20 }),
	fc.array(sweepRowArb('under'), { minLength: 1, maxLength: 20 })
);

async function seedSweepUser(): Promise<void> {
	await testDb()
		.db.insert(users)
		.values({ id: 'sweep-user', googleSub: 'sub-sweep', email: 'sweep@example.com', displayName: 'sweep' });
}

test('sweep: nullExpiredConsentEmails nulls exactly the over-cutoff e-mails, keeps everything else, and is idempotent', async () => {
	// Property audit: dropping the isNotNull or createdAt<cutoff predicate (or
	// flipping `<` to `<=`/`>`) mis-classifies a zone — red. Nulling any other
	// column, or rewriting docVersion/checkboxText/ip/userAgent, breaks the
	// untouched-field assertions. A non-idempotent second run breaks the
	// final deep-equal.
	await fc.assert(
		fc.asyncProperty(sweepArb, async ([over, under]) => {
			await wipeTables(WIPE);
			await seedSweepUser();
			const now = Date.now();
			// userAgent carries the row index so each seeded row is findable
			// after its e-mail (the natural key here) is nulled.
			const seeded = [...over, ...under].map((row, index) => ({
				...row,
				userAgent: `${row.userAgent}#${index}`,
				createdAt: toIso(now - row.ageMs)
			}));
			await testDb().db.insert(consents).values(
				seeded.map((row) => ({
					userId: 'sweep-user',
					email: row.email,
					docVersion: row.docVersion,
					checkboxText: row.checkboxText,
					ip: row.ip,
					userAgent: row.userAgent,
					createdAt: row.createdAt
				}))
			);

			expect(await nullExpiredConsentEmails()).toBe(over.length);

			const afterFirst = await testDb().db.select().from(consents).all();
			for (const row of seeded) {
				const stored = afterFirst.find((candidate) => candidate.userAgent === row.userAgent);
				expect(stored).toBeDefined();
				if (row.zone === 'over') {
					expect(stored?.email).toBeNull();
				} else {
					expect(stored?.email).toBe(row.email); // byte-identical
				}
				// The anonymized evidence row itself is untouched either way.
				expect(stored).toMatchObject({
					docVersion: row.docVersion,
					checkboxText: row.checkboxText,
					ip: row.ip,
					createdAt: row.createdAt
				});
			}
			// Idempotent: the second call erases nothing and changes nothing.
			expect(await nullExpiredConsentEmails()).toBe(0);
			const afterSecond = await testDb().db.select().from(consents).all();
			expect(sortBy(afterSecond, (row) => row.id)).toEqual(sortBy(afterFirst, (row) => row.id));
		})
	);
});

test('bounded sweep: more than 50 expired rows drain exactly 50 per call (I10)', async () => {
	// Property audit: dropping .limit(CONSENT_SWEEP_BATCH) nulls the whole
	// backlog in the first call — the exact-50 assertion goes red (the example
	// version of this bound lives in deletion.test.ts; here the backlog SIZE
	// is generated).
	await fc.assert(
		fc.asyncProperty(fc.integer({ min: 51, max: 80 }), async (count) => {
			await wipeTables(WIPE);
			await seedSweepUser();
			const expired = toIso(Date.now() - CONSENT_EMAIL_RETENTION_MS - GUARD_MS);
			await testDb().db.insert(consents).values(
				Array.from({ length: count }, (_, index) => ({
					userId: 'sweep-user',
					email: `bulk-${index}@example.com`,
					docVersion: 'v1.2',
					checkboxText: 'I agree',
					ip: '127.0.0.1',
					userAgent: 'test',
					createdAt: expired
				}))
			);

			expect(await nullExpiredConsentEmails()).toBe(50); // CONSENT_SWEEP_BATCH
			expect(await nullExpiredConsentEmails()).toBe(count - 50);
			expect(await nullExpiredConsentEmails()).toBe(0);
			const remaining = await testDb().db.select().from(consents).all();
			expect(remaining).toHaveLength(count); // rows kept, only e-mails erased
			expect(remaining.every((row) => row.email === null)).toBe(true);
		})
	);
});
