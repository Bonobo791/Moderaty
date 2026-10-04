import { beforeEach, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_OWNER, postForm, setupTestDb, statementSql, testDb } from '$lib/server/testdb';
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
import { applyHumanIntent, finalizeHumanIntent, runEnforcement } from './enforcement';
import { stageDecisions } from './staging';
import { DeadlineExceededError, RequestNotSentError } from '$lib/server/http';

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

function rescanApproval() {
	return stageDecisions('channel', [{
		comment: { id: 'comment', threadId: 'thread', videoId: null, authorChannelId: 'author', authorName: 'Author', text: 'Comment', publishedAt: '2026-01-01T00:00:00Z' },
		status: 'approved', decidedBy: 'allowlist', matchedRuleId: null, aiScore: null,
		auditAction: 'approve', reason: 'Rescan', youtubeAction: null
	}], { rescan: { scanStamp: 'new-scan' } });
}

test.each(['rejection', 'restore'])('a rescan preserves the recorded %s while token refresh precedes dispatch reservation', async (action) => {
	if (action === 'restore') await testDb().db.update(comments).set({ status: 'held' }).where(eq(comments.id, 'comment'));
	const entered = deferred();
	const finish = deferred();
	provider.refreshAccessToken.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; return 'access-token'; });
	const original = action === 'restore' ? log.undo(event()) : queue.reject(event());
	await entered.promise;
	try {
		const before = await row();
		expect(before).toMatchObject({ status: 'restoring', restoreIntentId: expect.any(Number), humanDispatchToken: null });
		await rescanApproval();
		expect(await row()).toMatchObject({ status: 'restoring', restoreIntentId: before!.restoreIntentId, humanDispatchToken: null, scanId: 'new-scan' });
		expect(await testDb().db.select().from(auditLog)).toHaveLength(1);
	} finally { finish.resolve(); await original; }
	expect(provider.setModerationStatus).toHaveBeenCalledTimes(1);
	expect(await row()).toMatchObject({ status: action === 'restore' ? 'approved' : 'rejected', decidedBy: 'human', restoreIntentId: null });
});

test('the human intent preflight reports deadline expiry as a request that never began', async () => {
	await expect(applyHumanIntent('comment', 'reject', 'access-token', Date.now() - 1)).rejects.toMatchObject({
		name: 'RequestNotSentError', cause: expect.any(DeadlineExceededError)
	});
	expect(provider.setModerationStatus).not.toHaveBeenCalled();
});

test('a local preparation failure before fetch returns the claim safely to the queue', async () => {
	provider.setModerationStatus.mockRejectedValueOnce(new RequestNotSentError(new DeadlineExceededError()));
	expect(await queue.reject(event())).toMatchObject({ status: 500 });
	expect(await row()).toMatchObject({ status: 'pending', restoreIntentId: null, humanDispatchToken: null, humanDispatchState: null });
	expect(await testDb().db.select().from(auditLog)).toEqual([]);
});

test('a settled corrective write releases its reservation after transient SQLite contention', async () => {
	await testDb().db.update(comments).set({ status: 'rejected', decidedBy: 'human' }).where(eq(comments.id, 'comment'));
	await testDb().db.insert(moderationActions).values({ channelId: 'channel', commentId: 'comment', action: 'hold', reason: 'Raced hold', state: 'cancelling' });
	const client = testDb().client;
	const execute = client.execute.bind(client);
	let blocked = false;
	const spy = vi.spyOn(client, 'execute').mockImplementation(async (...args) => {
		const sql = statementSql(args[0]);
		if (!blocked && sql.startsWith('update "comments" set "human_dispatch_token"')) {
			blocked = true;
			throw Object.assign(new Error('database is busy'), { code: 'SQLITE_BUSY' });
		}
		return execute(...args);
	});
	try { await reconcile(); } finally { spy.mockRestore(); }
	expect(blocked).toBe(true);
	expect(provider.setModerationStatus).toHaveBeenCalledTimes(1);
	expect(await row()).toMatchObject({ humanDispatchToken: null, humanDispatchState: null });
	expect((await testDb().db.select().from(moderationActions).get())?.state).toBe('superseded');
});

test('cron defers a human intent when too little request budget remains', async () => {
	const [intent] = await testDb().db.insert(auditLog).values({ channelId: 'channel', commentId: 'comment', action: 'reject', actor: 'user', reason: 'Recorded intent' }).returning({ id: auditLog.id });
	await testDb().db.update(comments).set({ status: 'restoring', restoreIntentId: intent.id }).where(eq(comments.id, 'comment'));
	await expect(runEnforcement('channel', 'access-token', Date.now() + 1_000, null, 0)).rejects.toBeInstanceOf(DeadlineExceededError);
	expect(provider.setModerationStatus).not.toHaveBeenCalled();
	expect(await row()).toMatchObject({ status: 'restoring', restoreIntentId: intent.id, humanDispatchToken: null, humanDispatchState: null });
});

test('reconciliation settles one recorded human write before starting the next', async () => {
	await testDb().db.insert(comments).values({ id: 'second', channelId: 'channel', text: 'Second', publishedAt: '2026-01-01T00:00:00Z', status: 'restoring', decidedBy: 'none' });
	for (const id of ['comment', 'second']) {
		const [intent] = await testDb().db.insert(auditLog).values({ channelId: 'channel', commentId: id, action: 'reject', actor: 'user', reason: 'Recorded intent' }).returning({ id: auditLog.id });
		await testDb().db.update(comments).set({ status: 'restoring', restoreIntentId: intent.id }).where(eq(comments.id, id));
	}
	const entered = deferred();
	const finish = deferred();
	let firstSettled = false;
	provider.setModerationStatus.mockImplementationOnce(async () => {
		entered.resolve();
		await finish.promise;
		firstSettled = true;
	}).mockImplementation(async () => { expect(firstSettled).toBe(true); });
	const running = reconcile();
	await entered.promise;
	try {
		expect(provider.setModerationStatus).toHaveBeenCalledTimes(1);
		expect(await testDb().db.select().from(comments).where(eq(comments.id, 'second')).get()).toMatchObject({
			status: 'restoring', humanDispatchToken: null, humanDispatchState: null
		});
	} finally { finish.resolve(); await running; }
	expect(provider.setModerationStatus).toHaveBeenCalledTimes(2);
	expect((await testDb().db.select().from(comments)).map((comment) => comment.status)).toEqual(['rejected', 'rejected']);
});

test('a history rescan preserves an active human decision and its audit while recording the scan', async () => {
	const entered = deferred();
	const finish = deferred();
	provider.setModerationStatus.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; });
	const original = queue.reject(event());
	await entered.promise;
	try {
		const before = await row();
		await rescanApproval();
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

test.each([new TypeError('connection lost after dispatch'), new DeadlineExceededError()])('an uncertain rejection keeps its exact intent and blocks a newer approval after %s', async (failureCause) => {
	let remote = 'published';
	let lateWrite!: () => void;
	provider.setModerationStatus.mockImplementationOnce(async () => {
		lateWrite = () => { remote = 'rejected'; };
		throw failureCause;
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
