import { beforeEach, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_OWNER, postForm, setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, comments, moderationActions } from '$lib/server/db/schema';

const provider = vi.hoisted(() => ({
	env: { DRY_RUN: 'false' },
	refreshAccessToken: vi.fn(), setModerationStatus: vi.fn(), deleteComment: vi.fn()
}));
vi.mock('$env/dynamic/private', () => ({ env: provider.env }));
vi.mock('$lib/server/crypto', () => ({ decrypt: () => 'refresh-token' }));
vi.mock('$lib/server/youtube', async (original) => ({
	...await original<typeof import('$lib/server/youtube')>(),
	...provider
}));

import { actions as queue } from '../../../routes/(app)/channels/[id]/queue/+page.server';
import { actions as log } from '../../../routes/(app)/channels/[id]/log/+page.server';
import { finalizeHumanIntent, runEnforcement } from './enforcement';
import { stageDecisions } from './staging';

setupTestDb(['channels', 'comments', 'audit_log', 'moderation_actions']);
beforeEach(async () => {
	vi.resetAllMocks();
	provider.refreshAccessToken.mockResolvedValue('access-token');
	provider.setModerationStatus.mockResolvedValue(undefined);
	await testDb().db.insert(channels).values({ id: 'channel', userId: TEST_OWNER.id, orgId: TEST_OWNER.orgId, title: 'Channel', refreshTokenEnc: 'enc' });
	await testDb().db.insert(comments).values({ id: 'comment', channelId: 'channel', text: 'Comment', publishedAt: '2026-01-01T00:00:00Z', status: 'pending', decidedBy: 'none' });
});

function event() {
	return { params: { id: 'channel' }, locals: { user: TEST_OWNER }, request: postForm({ commentId: 'comment' }) } as never;
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
const row = () => testDb().db.select().from(comments).where(eq(comments.id, 'comment')).get();
const reconcile = () => runEnforcement('channel', 'access-token', undefined, null, 0);

test('a history rescan preserves an active human decision and its audit while recording the scan', async () => {
	const entered = deferred();
	const finish = deferred();
	provider.setModerationStatus.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; });
	const original = queue.reject(event());
	await entered.promise;
	try {
		const before = await row();
		await stageDecisions('channel', [{
			comment: { id: 'comment', threadId: 'thread', videoId: null, authorChannelId: 'author', authorName: 'Author', text: 'Comment', publishedAt: '2026-01-01T00:00:00Z' },
			status: 'approved', decidedBy: 'allowlist', matchedRuleId: null, aiScore: null,
			auditAction: 'approve', reason: 'Rescan', youtubeAction: null
		}], { rescan: { scanStamp: 'new-scan' } });
		expect(await row()).toMatchObject({ status: 'restoring', restoreIntentId: before!.restoreIntentId, humanDispatchToken: before!.humanDispatchToken, scanId: 'new-scan' });
		expect(await testDb().db.select().from(auditLog)).toHaveLength(1);
	} finally { finish.resolve(); await original; }
	expect(await row()).toMatchObject({ status: 'rejected', decidedBy: 'human', restoreIntentId: null, humanDispatchToken: null });
});

test('cron cannot finish a duplicate rejection while the original request can still land', async () => {
	const entered = deferred();
	const finish = deferred();
	let remote = 'published';
	provider.setModerationStatus.mockImplementationOnce(async () => {
		entered.resolve();
		await finish.promise;
		remote = 'rejected';
	}).mockImplementation(async (_ids, status) => { remote = status; });
	const original = queue.reject(event());
	await entered.promise;
	try {
		await reconcile();
		expect(provider.setModerationStatus).toHaveBeenCalledTimes(1);
		expect(await row()).toMatchObject({ status: 'restoring', restoreIntentId: expect.any(Number) });
		await expect(log.undo(event())).rejects.toMatchObject({ status: 409 });
	} finally {
		finish.resolve();
		await original;
	}
	await log.undo(event());
	expect(await row()).toMatchObject({ status: 'approved' });
	expect(remote).toBe('published');
});

test('an uncertain rejection keeps its exact intent and blocks a newer approval', async () => {
	let remote = 'published';
	let lateWrite!: () => void;
	provider.setModerationStatus.mockImplementationOnce(async () => {
		lateWrite = () => { remote = 'rejected'; };
		throw new TypeError('connection lost after dispatch');
	}).mockImplementation(async (_ids, status) => { remote = status; });
	const failure = await queue.reject(event());
	expect(failure).toMatchObject({ status: 500 });
	expect(await row()).toMatchObject({ status: 'restoring', restoreIntentId: expect.any(Number) });
	const bound = (await row())!.restoreIntentId;
	expect(await testDb().db.select().from(auditLog).where(eq(auditLog.id, bound!)).get()).toMatchObject({ action: 'reject', actor: 'user' });
	await expect(queue.approve(event())).rejects.toMatchObject({ status: 404 });
	await reconcile();
	expect(provider.setModerationStatus).toHaveBeenCalledTimes(1);
	lateWrite();
	expect(remote).toBe('rejected');
	expect(await row()).toMatchObject({ status: 'restoring', restoreIntentId: bound });
});

test('a stale finalizer cannot unlock another dispatch owner of the same intent', async () => {
	const entered = deferred();
	const finish = deferred();
	provider.setModerationStatus.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; });
	const original = queue.reject(event());
	await entered.promise;
	try {
		const bound = (await row())!.restoreIntentId!;
		await finalizeHumanIntent('channel', 'comment', 'reject', bound);
		expect(await row()).toMatchObject({ status: 'restoring', restoreIntentId: bound });
	} finally {
		finish.resolve();
		await original;
	}
	expect(await row()).toMatchObject({ status: 'rejected', restoreIntentId: null });
});

test('a decided-state correction cannot land after a newer Undo', async () => {
	await testDb().db.update(comments).set({ status: 'rejected', decidedBy: 'human' }).where(eq(comments.id, 'comment'));
	await testDb().db.insert(moderationActions).values({ channelId: 'channel', commentId: 'comment', action: 'hold', reason: 'Raced hold', state: 'cancelling' });
	const entered = deferred();
	const finish = deferred();
	let remote = 'published';
	provider.setModerationStatus.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; remote = 'rejected'; })
		.mockImplementation(async (_ids, status) => { remote = status; });
	const correction = reconcile();
	await entered.promise;
	try {
		await expect(log.undo(event())).rejects.toMatchObject({ status: 409 });
		expect(provider.setModerationStatus).toHaveBeenCalledTimes(1);
	} finally {
		finish.resolve();
		await correction;
	}
	await log.undo(event());
	expect(await row()).toMatchObject({ status: 'approved' });
	expect(remote).toBe('published');
});

test('an uncertain correction pauses newer staged enforcement even if the local verdict changes', async () => {
	await testDb().db.update(comments).set({ status: 'rejected', decidedBy: 'human' }).where(eq(comments.id, 'comment'));
	await testDb().db.insert(moderationActions).values({ channelId: 'channel', commentId: 'comment', action: 'hold', reason: 'Raced hold', state: 'cancelling' });
	provider.setModerationStatus.mockRejectedValueOnce(new TypeError('lost correction response'));
	await reconcile();
	expect(await row()).toMatchObject({ humanDispatchState: 'uncertain' });
	await testDb().db.update(comments).set({ status: 'pending' }).where(eq(comments.id, 'comment'));
	await testDb().db.update(moderationActions).set({ state: 'pending' }).where(eq(moderationActions.commentId, 'comment'));
	await reconcile();
	expect(provider.setModerationStatus).toHaveBeenCalledTimes(1);
	expect(await row()).toMatchObject({ humanDispatchState: 'uncertain' });
});

test('a decided correction fences a leftover binding without treating it as the current intent', async () => {
	const [old] = await testDb().db.insert(auditLog).values({ channelId: 'channel', commentId: 'comment', action: 'restore', actor: 'user', reason: 'Older claim' }).returning({ id: auditLog.id });
	await testDb().db.update(comments).set({ status: 'rejected', restoreIntentId: old.id }).where(eq(comments.id, 'comment'));
	await testDb().db.insert(moderationActions).values({ channelId: 'channel', commentId: 'comment', action: 'hold', reason: 'Raced hold', state: 'cancelling' });
	await reconcile();
	expect(provider.setModerationStatus).toHaveBeenCalledExactlyOnceWith(['comment'], 'rejected', false, 'access-token', undefined, true);
	expect(await row()).toMatchObject({ status: 'rejected', restoreIntentId: old.id, humanDispatchToken: null });
	expect((await testDb().db.select().from(moderationActions).get())?.state).toBe('superseded');
});
