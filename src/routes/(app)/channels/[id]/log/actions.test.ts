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

import { beforeEach, expect, test, vi } from 'vitest';
import { TEST_OWNER, postForm, setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, comments, moderationActions } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	env: { DRY_RUN: 'false' } as Record<string, string | undefined>,
	decrypt: vi.fn((_enc: string) => 'decrypted-refresh-token'),
	refreshAccessToken: vi.fn(async (_token: string) => 'access-token'),
	setModerationStatus: vi.fn(async () => {})
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/crypto', () => ({ decrypt: mocks.decrypt }));
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: mocks.refreshAccessToken,
	setModerationStatus: mocks.setModerationStatus
}));

import { actions } from './+page.server';

setupTestDb(['audit_log', 'comments', 'channels', 'moderation_actions']);

const OWNER = TEST_OWNER;
const LOG_URL = 'http://localhost/channels/UC1/log';

beforeEach(async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'One', refreshTokenEnc: 'enc-1' });
	mocks.env.DRY_RUN = 'false';
	vi.clearAllMocks();
});

async function seedComment(id: string, status: string, priorAction: string, channelId = 'UC1') {
	await testDb().db.insert(comments).values({
		id,
		channelId,
		text: 'hello',
		publishedAt: '2026-01-01T00:00:00Z',
		status,
		decidedBy: 'ai'
	});
	await testDb()
		.db.insert(auditLog)
		.values({ channelId, commentId: id, action: priorAction, reason: 'ai score 0.91', actor: 'system' });
}

function undo(commentId: string | null, channelId = 'UC1', user: typeof OWNER | null = OWNER) {
	return actions.undo({
		params: { id: channelId },
		request: postForm(commentId === null ? {} : { commentId }, LOG_URL),
		locals: { user }
	} as never);
}

async function commentRow(id: string) {
	return testDb().db.select().from(comments).where(eq(comments.id, id)).get();
}

test('undo restores a rejected comment at YouTube and records the restore', async () => {
	await seedComment('c1', 'rejected', 'reject');

	const res = await undo('c1');

	expect(res).toMatchObject({ success: expect.stringContaining('estored') });
	// The restore runs on the OWNED channel's credential, decrypted — a wrong
	// or skipped token step fails this test.
	expect(mocks.decrypt).toHaveBeenCalledWith('enc-1');
	expect(mocks.refreshAccessToken).toHaveBeenCalledWith('decrypted-refresh-token');
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'published', false, 'access-token');
	expect(await commentRow('c1')).toMatchObject({ status: 'approved', decidedBy: 'human' });
	expect(await testDb().db.select().from(auditLog).all()).toContainEqual(
		// authorHandle is null: manual actions have no handle source (the
		// author's name is never persisted on the comment row by design).
		expect.objectContaining({ commentId: 'c1', action: 'restore', reason: 'undo of reject', actor: 'user', authorHandle: null })
	);
});

test('undo of a ban restores the comment and names the original action', async () => {
	await seedComment('c1', 'rejected', 'ban');

	await undo('c1');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'published', false, 'access-token');
	expect(await commentRow('c1')).toMatchObject({ status: 'approved' });
	expect(await testDb().db.select().from(auditLog).all()).toContainEqual(
		expect.objectContaining({ commentId: 'c1', action: 'restore', reason: 'undo of ban', actor: 'user' })
	);
});

test('undo on a deleted comment 404s and changes nothing', async () => {
	await seedComment('c1', 'deleted', 'delete');

	await expect(undo('c1')).rejects.toMatchObject({
		status: 404,
		body: { message: 'reversible comment not found in this channel' }
	});

	expect(await commentRow('c1')).toMatchObject({ status: 'deleted' });
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(await testDb().db.select().from(auditLog).all()).toHaveLength(1); // only the seeded row
});

test('a YouTube failure releases the claim and fails loudly', async () => {
	await seedComment('c1', 'rejected', 'reject');
	mocks.setModerationStatus.mockRejectedValueOnce(new Error('YouTube refused the transition'));

	await expect(undo('c1')).rejects.toThrow('YouTube refused the transition');

	// Back to the pre-undo state, so the action stays retryable.
	expect(await commentRow('c1')).toMatchObject({ status: 'rejected', decidedBy: 'ai' });
	expect(await testDb().db.select().from(auditLog).all()).toHaveLength(1);
});

test('a dry run records a dry-run audit row and makes no YouTube call', async () => {
	mocks.env.DRY_RUN = 'true';
	await seedComment('c1', 'held', 'hold');

	await undo('c1');

	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(await commentRow('c1')).toMatchObject({ status: 'approved', decidedBy: 'human' });
	expect(await testDb().db.select().from(auditLog).all()).toContainEqual(
		expect.objectContaining({ commentId: 'c1', action: 'dry-run', reason: 'undo of hold', actor: 'user' })
	);
});

test('a failed audit insert leaves the undo retryable in a restoring state', async () => {
	await seedComment('c1', 'rejected', 'reject');
	// The remote restore succeeds but the audit-row transaction fails.
	await testDb().client.execute(
		`CREATE TRIGGER fail_audit_insert BEFORE INSERT ON audit_log
		 WHEN NEW.action = 'restore' BEGIN SELECT RAISE(ABORT, 'simulated audit insert failure'); END`
	);
	try {
		await expect(undo('c1')).rejects.toThrow(/Failed query|simulated audit insert failure/);
	} finally {
		await testDb().client.execute('DROP TRIGGER fail_audit_insert');
	}

	// Not lost, not half-recorded: the comment parks in 'restoring' with NO
	// audit row yet, so the undo can be retried instead of 404ing forever.
	expect(await commentRow('c1')).toMatchObject({ status: 'restoring' });
	expect((await testDb().db.select().from(auditLog).all()).filter((row) => row.action === 'restore')).toHaveLength(0);

	// The retry re-applies the (idempotent) YouTube call and completes.
	const res = await undo('c1');

	expect(res).toMatchObject({ success: expect.stringContaining('estored') });
	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(2);
	expect(await commentRow('c1')).toMatchObject({ status: 'approved', decidedBy: 'human' });
	expect(await testDb().db.select().from(auditLog).all()).toContainEqual(
		expect.objectContaining({ commentId: 'c1', action: 'restore', reason: 'undo of reject', actor: 'user' })
	);
});

test('undo rejects a signed-out request with 401', async () => {
	await expect(undo('c1', 'UC1', null)).rejects.toMatchObject({ status: 401 });
});

test('undo on another team\'s channel 404s without leaking existence', async () => {
	// The caller personally connected UC2 — under a different team. The org
	// gate must still 404 it (a per-user check would wrongly pass here).
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC2', userId: OWNER.id, orgId: 'org-2', title: 'Two', refreshTokenEnc: 'enc-2' });
	await seedComment('c9', 'rejected', 'reject', 'UC2');

	await expect(undo('c9', 'UC2')).rejects.toMatchObject({ status: 404 });
	expect(await commentRow('c9')).toMatchObject({ status: 'rejected' });
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
});

test('undo without a comment id fails with 400', async () => {
	const res = await undo(null);
	expect(res).toMatchObject({ status: 400, data: { error: 'Invalid comment ID' } });
});

test('a whitespace-only comment id is trimmed away and fails with 400', async () => {
	const res = await undo('   ');
	expect(res).toMatchObject({ status: 400, data: { error: 'Invalid comment ID' } });
});

test('undo with no prior audit row still restores and names the generic action', async () => {
	// A comment can be held without any hold/reject/ban audit row (e.g. history
	// predating the log); the undo must still land with a sensible reason.
	await testDb().db.insert(comments).values({
		id: 'c1',
		channelId: 'UC1',
		text: 'hello',
		publishedAt: '2026-01-01T00:00:00Z',
		status: 'held',
		decidedBy: 'ai'
	});

	const res = await undo('c1');

	expect(res).toMatchObject({ success: expect.stringContaining('estored') });
	expect(await commentRow('c1')).toMatchObject({ status: 'approved', decidedBy: 'human' });
	expect(await testDb().db.select().from(auditLog).all()).toContainEqual(
		expect.objectContaining({ commentId: 'c1', action: 'restore', reason: 'undo of moderation action', actor: 'user' })
	);
});

test('a concurrent undo that loses the atomic claim 404s instead of double-restoring', async () => {
	await seedComment('c1', 'rejected', 'reject');

	// Both submissions read status='rejected' before either claims; the
	// conditional claim update makes exactly one winner (I3/I4).
	const [first, second] = await Promise.allSettled([undo('c1'), undo('c1')]);

	const outcomes = [first, second];
	expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
	const losers = outcomes.filter((r) => r.status === 'rejected');
	expect(losers).toHaveLength(1);
	expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
		status: 404,
		body: { message: 'reversible comment not found in this channel' }
	});
	// One remote restore, one audit row, final state approved.
	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(1);
	expect(await commentRow('c1')).toMatchObject({ status: 'approved', decidedBy: 'human' });
	expect((await testDb().db.select().from(auditLog).all()).filter((row) => row.action === 'restore')).toHaveLength(1);
});

/** Seeds one audit row with a stored commenter handle (no comment row needed). */
async function seedHandledAuditRow(commentId: string, handle: string | null, channelId = 'UC1') {
	await testDb().db.insert(auditLog).values({
		channelId,
		commentId,
		action: 'reject',
		reason: 'ai score 0.91',
		actor: 'system',
		authorHandle: handle
	});
}

/** Seeds one moderation action row with a stored commenter handle. */
async function seedHandledActionRow(commentId: string, handle: string | null, channelId = 'UC1') {
	await testDb().db.insert(moderationActions).values({
		commentId,
		channelId,
		action: 'ban',
		reason: 'rule #1 (user: troll)',
		state: 'completed',
		authorHandle: handle
	});
}

function eraseHandles(channelId = 'UC1', user: typeof OWNER | null = OWNER) {
	return actions.eraseHandles({
		params: { id: channelId },
		request: postForm({}, LOG_URL),
		locals: { user }
	} as never);
}

test('eraseHandles nulls every stored handle for the channel in BOTH tables, leaving rows and other channels intact', async () => {
	await seedHandledAuditRow('c1', '@first.user');
	await seedHandledAuditRow('c2', '@second.user');
	await seedHandledAuditRow('c3', null);
	await seedHandledActionRow('a1', '@first.user');
	await seedHandledActionRow('a2', null);
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC2', userId: OWNER.id, orgId: 'org-1', title: 'Two', refreshTokenEnc: 'enc-2' });
	await seedHandledAuditRow('c9', '@other.channel', 'UC2');
	await seedHandledActionRow('a9', '@other.channel', 'UC2');

	const res = await eraseHandles();

	expect(res).toMatchObject({ success: 'Stored handles erased for this channel.' });
	const rows = await testDb().db.select().from(auditLog).all();
	// Only the handle goes — action, reason, and actor stay byte-identical.
	const mine = rows.filter((row) => row.channelId === 'UC1');
	expect(mine).toHaveLength(3);
	for (const row of mine) {
		expect(row).toMatchObject({ authorHandle: null, action: 'reject', reason: 'ai score 0.91', actor: 'system' });
	}
	const actionRows = await testDb().db.select().from(moderationActions).all();
	const myActions = actionRows.filter((row) => row.channelId === 'UC1');
	expect(myActions).toHaveLength(2);
	for (const row of myActions) {
		expect(row).toMatchObject({ authorHandle: null, action: 'ban', reason: 'rule #1 (user: troll)' });
	}
	// Another channel's stored handles are untouched in both tables.
	expect(rows.find((row) => row.channelId === 'UC2')).toMatchObject({ authorHandle: '@other.channel' });
	expect(actionRows.find((row) => row.channelId === 'UC2')).toMatchObject({ authorHandle: '@other.channel' });
});

test('eraseHandles is atomic: a failure on one table leaves both tables untouched', async () => {
	// The two updates run in one transaction: if the moderation_actions wipe
	// fails, the audit_log wipe must roll back with it — a half-erased channel
	// would lie to the user about what was erased.
	await seedHandledAuditRow('c1', '@some.user');
	await seedHandledActionRow('a1', '@some.user');
	await testDb().client.execute(
		`CREATE TRIGGER fail_action_handle_update BEFORE UPDATE ON moderation_actions
		 BEGIN SELECT RAISE(ABORT, 'simulated erase failure'); END`
	);
	try {
		await expect(eraseHandles()).rejects.toThrow();
	} finally {
		await testDb().client.execute('DROP TRIGGER fail_action_handle_update');
	}

	expect((await testDb().db.select().from(auditLog).all())[0]).toMatchObject({ authorHandle: '@some.user' });
	expect((await testDb().db.select().from(moderationActions).all())[0]).toMatchObject({ authorHandle: '@some.user' });
});

test('eraseHandles on another team\'s channel 404s without touching its rows', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC2', userId: OWNER.id, orgId: 'org-2', title: 'Two', refreshTokenEnc: 'enc-2' });
	await seedHandledAuditRow('c9', '@their.user', 'UC2');

	await expect(eraseHandles('UC2')).rejects.toMatchObject({ status: 404 });

	expect((await testDb().db.select().from(auditLog).all())[0]).toMatchObject({ authorHandle: '@their.user' });
});

test('eraseHandles rejects a signed-out request with 401 and erases nothing', async () => {
	await seedHandledAuditRow('c1', '@some.user');

	await expect(eraseHandles('UC1', null)).rejects.toMatchObject({ status: 401 });

	expect((await testDb().db.select().from(auditLog).all())[0]).toMatchObject({ authorHandle: '@some.user' });
});
