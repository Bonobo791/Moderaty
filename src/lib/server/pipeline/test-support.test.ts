import { afterEach, beforeEach, expect, test } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { auditLog, channels, comments } from '$lib/server/db/schema';
import { getMocks, resetPipelineMocks, restoreDryRun } from './test-support';

const mocks = getMocks();
beforeEach(resetPipelineMocks);
afterEach(restoreDryRun);

test.each(['ID first', 'ID last'])('audit queries select the exact intent with %s', async (order) => {
	mocks.state.insertedAudits = [
		{ id: 7, channelId: 'channel', commentId: 'comment', actor: 'user', action: 'restore' },
		{ id: 8, channelId: 'channel', commentId: 'comment', actor: 'user', action: 'ban' }
	];
	const scope = [eq(auditLog.channelId, 'channel'), eq(auditLog.commentId, 'comment'), eq(auditLog.actor, 'user')];
	const condition = order === 'ID first' ? and(eq(auditLog.id, 7), ...scope) : and(...scope, eq(auditLog.id, 7));
	const row = await mocks.db.select().from(auditLog).where(condition).get();
	expect(row).toEqual(mocks.state.insertedAudits[0]);
});

test('audit queries cannot borrow another intent when the bound ID is missing', async () => {
	mocks.state.insertedAudits = [{ id: 7, channelId: 'channel', commentId: 'comment', actor: 'user', action: 'restore' }];
	const row = await mocks.db.select().from(auditLog).where(and(
		eq(auditLog.channelId, 'channel'), eq(auditLog.id, 99), eq(auditLog.commentId, 'comment'), eq(auditLog.actor, 'user')
	)).get();
	expect(row).toBeUndefined();
});

test('audit queries require the bound actor even when a newer system row has the same scope', async () => {
	mocks.state.insertedAudits = [
		{ id: 7, channelId: 'channel', commentId: 'comment', actor: 'user', action: 'restore' },
		{ id: 8, channelId: 'channel', commentId: 'comment', actor: 'system', action: 'reject' }
	];
	const row = await mocks.db.select().from(auditLog).where(and(
		eq(auditLog.commentId, 'comment'), eq(auditLog.actor, 'user'), eq(auditLog.channelId, 'channel')
	)).get();
	expect(row).toEqual(mocks.state.insertedAudits[0]);
});

test.each(['staged', 'existing'])('a stale intent cannot finalize a %s restoring row', async (kind) => {
	const row = { id: 'comment', status: 'restoring', decidedBy: 'human', restoreIntentId: 8 };
	if (kind === 'staged') mocks.state.insertedComments = [row];
	else {
		mocks.state.existingIds = ['comment'];
		mocks.state.commentStatuses = { comment: 'restoring' };
		mocks.state.commentRestoreIntentIds = { comment: 8 };
	}
	const changed = await mocks.db.update(comments).set({ status: 'approved', restoreIntentId: null }).where(and(
		eq(comments.status, 'restoring'), eq(comments.restoreIntentId, 7), eq(comments.id, 'comment')
	)).returning({ id: comments.id });
	expect(changed).toEqual([]);
	if (kind === 'staged') expect(row).toMatchObject({ status: 'restoring', restoreIntentId: 8 });
	else {
		expect(mocks.state.commentStatuses.comment).toBe('restoring');
		expect(mocks.state.commentRestoreIntentIds.comment).toBe(8);
	}
});

test.each(['staged', 'existing'])('a null intent guard cannot erase a bound %s restoring row', async (kind) => {
	const row = { id: 'comment', status: 'restoring', restoreIntentId: 8 };
	if (kind === 'staged') mocks.state.insertedComments = [row];
	else {
		mocks.state.existingIds = ['comment'];
		mocks.state.commentStatuses = { comment: 'restoring' };
		mocks.state.commentRestoreIntentIds = { comment: 8 };
	}
	const changed = await mocks.db.update(comments).set({ status: 'approved', restoreIntentId: null }).where(and(
		eq(comments.id, 'comment'), isNull(comments.restoreIntentId), eq(comments.status, 'restoring')
	)).returning({ id: comments.id });
	expect(changed).toEqual([]);
	if (kind === 'staged') expect(row).toMatchObject({ status: 'restoring', restoreIntentId: 8 });
	else expect(mocks.state.commentRestoreIntentIds.comment).toBe(8);
});

test.each(['staged', 'existing'])('a matching intent can finalize a %s restoring row', async (kind) => {
	const row = { id: 'comment', status: 'restoring', restoreIntentId: 8 };
	if (kind === 'staged') mocks.state.insertedComments = [row];
	else {
		mocks.state.existingIds = ['comment'];
		mocks.state.commentStatuses = { comment: 'restoring' };
		mocks.state.commentRestoreIntentIds = { comment: 8 };
	}
	const changed = await mocks.db.update(comments).set({ status: 'approved', restoreIntentId: null }).where(and(
		eq(comments.id, 'comment'), eq(comments.status, 'restoring'), eq(comments.restoreIntentId, 8)
	)).returning({ id: comments.id });
	expect(changed).toEqual([{ id: 'comment' }]);
	if (kind === 'staged') expect(row).toMatchObject({ status: 'approved', restoreIntentId: null });
	else {
		expect(mocks.state.commentStatuses.comment).toBe('approved');
		expect(mocks.state.commentRestoreIntentIds.comment).toBeNull();
	}
});

test('channel guards still match their qualified columns after earlier parameters', async () => {
	mocks.state.channel.historyScanId = 'current-scan';
	mocks.state.channel.historyBoundary = null;
	const changed = await mocks.db.update(channels).set({ cursor: 'next' }).where(and(
		eq(channels.id, 'channel'), eq(channels.historyScanId, 'stale-scan'), isNull(channels.historyBoundary)
	)).returning({ id: channels.id });
	expect(changed).toEqual([]);
	expect(mocks.state.channelUpdates).toEqual([]);
});
