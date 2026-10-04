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
import * as http from '$lib/server/http';

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

async function seedRecoveryRows(count: number) {
	await testDb().db.insert(comments).values(Array.from({ length: count }, (_, index) => ({
		id: `a-${String(index).padStart(3, '0')}`, channelId: 'channel', text: 'Invalid binding',
		publishedAt: '2026-01-01T00:00:00Z', status: 'restoring', decidedBy: 'none'
	})));
}
async function recoveryCursor() {
	const raw = (await testDb().db.select().from(channels).get())?.humanRecoveryCursor;
	if (!raw) throw new Error('fixture has no recovery checkpoint');
	return JSON.parse(raw);
}

test('recovery visits at most 25 unreserved claims per tick and progresses past invalid bindings', async () => {
	await seedRecoveryRows(60);
	const [intent] = await testDb().db.insert(auditLog).values({ channelId: 'channel', commentId: 'comment', action: 'reject', actor: 'user', reason: 'Recorded intent' }).returning({ id: auditLog.id });
	await testDb().db.update(comments).set({ status: 'restoring', restoreIntentId: intent.id }).where(eq(comments.id, 'comment'));
	await reconcile();
	expect(provider.setModerationStatus).not.toHaveBeenCalled();
	await reconcile();
	expect(provider.setModerationStatus).not.toHaveBeenCalled();
	await reconcile();
	expect(provider.setModerationStatus).toHaveBeenCalledExactlyOnceWith(['comment'], 'rejected', false, 'access-token', undefined, true);
	expect(await row()).toMatchObject({ status: 'rejected', restoreIntentId: null });
});

test('recovery uses the eligible partial index to skip thousands of permanent reservations', async () => {
	await testDb().client.execute({ sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
		INSERT INTO comments (id, channel_id, text, published_at, status, decided_by, human_dispatch_token, human_dispatch_state)
		SELECT printf('a-%04d', i), 'channel', 'Blocked', '2026-01-01', 'restoring', 'human', printf('token-%04d', i), 'uncertain' FROM n`, args: [2000] });
	const [intent] = await testDb().db.insert(auditLog).values({ channelId: 'channel', commentId: 'comment', action: 'reject', actor: 'user', reason: 'Recorded intent' }).returning({ id: auditLog.id });
	await testDb().db.update(comments).set({ status: 'restoring', restoreIntentId: intent.id }).where(eq(comments.id, 'comment'));
	const execute = testDb().client.execute.bind(testDb().client);
	let scanSteps = 0;
	let vmSteps = 0;
	let eligibleQueries = 0;
	const spy = vi.spyOn(testDb().client, 'execute').mockImplementation(async (statement, args) => {
		const result = await execute(statement, args);
		const sql = statementSql(statement);
		if (sql.startsWith('select ') && sql.includes('from "comments"') && sql.includes('"human_dispatch_token" is null')) {
			eligibleQueries++;
			const stats = await execute({ sql: 'SELECT nscan, nstep FROM sqlite_stmt WHERE sql = ?', args: [sql] });
			expect(stats.rows.length).toBeGreaterThan(0);
			for (const entry of stats.rows) { scanSteps += Number(entry.nscan); vmSteps += Number(entry.nstep); }
			expect(sql).toContain('indexed by comments_human_recovery_eligible_idx');
		}
		return result;
	});
	try { await reconcile(); } finally { spy.mockRestore(); }
	expect(eligibleQueries).toBe(2);
	expect(scanSteps).toBeLessThan(10);
	expect(vmSteps).toBeLessThan(200);
	expect(provider.setModerationStatus).toHaveBeenCalledOnce();
	expect(await row()).toMatchObject({ status: 'rejected' });
	expect((await execute("SELECT count(*) AS count FROM comments WHERE human_dispatch_state = 'uncertain'")).rows[0].count).toBe(2000);
});

test('deadline expiry between claims retains the last completed checkpoint and retries the untouched row', async () => {
	await seedRecoveryRows(1);
	const [intent] = await testDb().db.insert(auditLog).values({ channelId: 'channel', commentId: 'comment', action: 'reject', actor: 'user', reason: 'Recorded intent' }).returning({ id: auditLog.id });
	await testDb().db.update(comments).set({ status: 'restoring', restoreIntentId: intent.id }).where(eq(comments.id, 'comment'));
	const deadline = Date.now() + 60_000;
	let expired = false;
	const assertBeforeDeadline = http.assertBeforeDeadline;
	const deadlineCheck = vi.spyOn(http, 'assertBeforeDeadline').mockImplementation(value => { if (expired) throw new DeadlineExceededError(); assertBeforeDeadline(value); });
	const warning = vi.spyOn(console, 'warn').mockImplementation((message) => { if (String(message).includes('no valid bound')) expired = true; });
	try { await expect(runEnforcement('channel', 'access-token', deadline, null, 0)).rejects.toBeInstanceOf(DeadlineExceededError); }
	finally { deadlineCheck.mockRestore(); warning.mockRestore(); }
	expect(await recoveryCursor()).toMatchObject({ afterId: 'a-000', endId: 'comment', done: false });
	expect(provider.setModerationStatus).not.toHaveBeenCalled();
	await reconcile();
	expect(provider.setModerationStatus).toHaveBeenCalledOnce();
	expect(await recoveryCursor()).toMatchObject({ afterId: 'comment', done: true });
});

test('a fixed recovery end wraps despite new high IDs and visits new low IDs in the next cycle', async () => {
	await seedRecoveryRows(30);
	await reconcile();
	const first = await recoveryCursor();
	expect(first).toMatchObject({ afterId: 'a-024', endId: 'a-029', done: false });
	await testDb().db.insert(comments).values(['0-new', 'z-new'].map(id => ({ id, channelId: 'channel', text: 'New', publishedAt: '2026-01-01', status: 'restoring', decidedBy: 'none' })));
	await reconcile();
	expect(await recoveryCursor()).toMatchObject({ cycleId: first.cycleId, afterId: 'a-029', endId: 'a-029', done: true });
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		await reconcile();
		expect(warning).toHaveBeenCalledWith(expect.stringContaining('no valid bound'), '0-new');
	} finally { warning.mockRestore(); }
	expect(await recoveryCursor()).toMatchObject({ afterId: 'a-023', endId: 'z-new', done: false });
	expect((await recoveryCursor()).cycleId).not.toBe(first.cycleId);
});

test('a disappeared or newly reserved tail completes the finite recovery cycle', async () => {
	await seedRecoveryRows(30);
	await reconcile();
	await testDb().client.execute("UPDATE comments SET human_dispatch_token = 'owner', human_dispatch_state = 'uncertain' WHERE id >= 'a-025' AND status = 'restoring'");
	await reconcile();
	expect(await recoveryCursor()).toMatchObject({ afterId: 'a-024', endId: 'a-029', done: true });
});

test.each(['checkpoint', 'lease', 'connector', 'cycle'])('stale recovery stops after a successor changes its %s', async (replacement) => {
	await seedRecoveryRows(2);
	const initialLease = '2026-10-04T22:00:00Z';
	await testDb().db.update(channels).set({ leaseExpiresAt: initialLease });
	const expected = await testDb().db.select().from(channels).get();
	if (!expected) throw new Error('fixture has no channel');
	let successorRaw: string | null = null;
	let changed = false;
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
	// Change ownership after the old worker reads the first intent, before its
	// progress CAS. A new cycle deliberately repeats all other checkpoint data.
	const execute = testDb().client.execute.bind(testDb().client);
	const spy = vi.spyOn(testDb().client, 'execute').mockImplementation(async (statement, args) => {
		const result = await execute(statement, args);
		if (!changed && statementSql(statement).includes('from "comments"') && statementSql(statement).includes('order by "comments"."id" asc')) {
			changed = true;
			const cursor = await recoveryCursor();
			let changedCursor = cursor;
			if (replacement === 'cycle') changedCursor = { ...cursor, cycleId: 'successor-cycle' };
			if (replacement === 'checkpoint') changedCursor = { ...cursor, afterId: 'a-001', done: true };
			successorRaw = JSON.stringify(changedCursor);
			await testDb().db.update(channels).set({ humanRecoveryCursor: successorRaw, ...(replacement === 'lease' ? { leaseExpiresAt: 'successor-lease' } : {}), ...(replacement === 'connector' ? { userId: 'successor', refreshTokenEnc: 'successor-grant' } : {}) });
		}
		return result;
	});
	try {
		const running = runEnforcement('channel', 'access-token', undefined, null, 0, expected);
		if (replacement === 'connector') await expect(running).rejects.toThrow(/deactivated/); else await running;
		expect(warning.mock.calls.filter(([message]) => String(message).includes('no valid bound'))).toHaveLength(1);
	} finally { spy.mockRestore(); warning.mockRestore(); }
	expect(changed).toBe(true);
	expect((await testDb().db.select().from(channels).get())?.humanRecoveryCursor).toBe(successorRaw);
	expect(provider.setModerationStatus).not.toHaveBeenCalled();
});

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
