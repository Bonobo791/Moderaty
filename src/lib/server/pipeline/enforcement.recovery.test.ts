import { beforeEach, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, comments, moderationActions } from '$lib/server/db/schema';

const youtube = vi.hoisted(() => ({ setModerationStatus: vi.fn(), deleteComment: vi.fn() }));
vi.mock('$lib/server/youtube', async (importOriginal) => ({
	...await importOriginal<typeof import('$lib/server/youtube')>(),
	...youtube
}));

import { finalizeHumanIntent, runEnforcement } from './enforcement';

setupTestDb(['channels', 'comments', 'audit_log', 'moderation_actions']);

beforeEach(async () => {
	vi.clearAllMocks();
	await testDb().db.insert(channels).values({ id: 'channel', title: 'Test channel', refreshTokenEnc: 'enc' });
	await testDb().db.insert(comments).values({
		id: 'comment', channelId: 'channel', text: 'Comment', publishedAt: '2026-01-01T00:00:00.000Z', status: 'restoring', decidedBy: 'human'
	});
});

async function audit(action: string, actor: string, createdAt: string, channelId = 'channel', commentId = 'comment') {
	const [row] = await testDb().db.insert(auditLog).values({ channelId, commentId, action, actor, reason: 'Recovery fixture', createdAt }).returning({ id: auditLog.id });
	return row.id;
}

async function bind(intentId: number) {
	await testDb().db.update(comments).set({ restoreIntentId: intentId }).where(eq(comments.id, 'comment'));
}

const reconcile = () => runEnforcement('channel', 'access-token', undefined, null, 0);
const comment = () => testDb().db.select().from(comments).where(eq(comments.id, 'comment')).get();

async function expectNoReplayedIntent() {
	await reconcile();
	expect(youtube.setModerationStatus).not.toHaveBeenCalled();
	expect(youtube.deleteComment).not.toHaveBeenCalled();
	expect((await comment())?.status).toBe('restoring');
}

test.each(['approve', 'restore'])('an interrupted %s survives a newer system audit and finalizes once', async (action) => {
	await bind(await audit(action, 'user', '2026-01-01T00:00:00.000Z'));
	await audit('reject', 'system', '2026-01-02T00:00:00.000Z');
	await testDb().db.insert(moderationActions).values({ channelId: 'channel', commentId: 'comment', action: 'reject', reason: 'Older dispatched rejection', state: 'dispatched' });

	await reconcile();

	expect(youtube.setModerationStatus).toHaveBeenCalledExactlyOnceWith(['comment'], 'published', false, 'access-token', undefined);
	expect((await comment())?.status).toBe('approved');
	expect((await testDb().db.select().from(moderationActions).get())?.state).toBe('cancelling');
	// The stale remote rejection may still land after the human publish. The
	// next sweep must correct it before terminalizing the outstanding row.
	await reconcile();
	expect(youtube.setModerationStatus).toHaveBeenCalledTimes(2);
	expect((await testDb().db.select().from(moderationActions).get())?.state).toBe('superseded');
	await reconcile();
	expect(youtube.setModerationStatus).toHaveBeenCalledTimes(2);
});

test.each(['later timestamp', 'same timestamp'])('replays the bound human intent with %s even with a newer system row', async (ordering) => {
	await audit('approve', 'user', '2026-01-01T00:00:00.000Z');
	await bind(await audit('reject', 'user', ordering === 'same timestamp' ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z'));
	await audit('approve', 'system', '2026-01-03T00:00:00.000Z');

	await reconcile();

	expect(youtube.setModerationStatus).toHaveBeenCalledExactlyOnceWith(['comment'], 'rejected', false, 'access-token', undefined);
	expect((await comment())?.status).toBe('rejected');
});

test('does not reuse a human intent from another channel', async () => {
	await bind(await audit('approve', 'user', '2026-01-01T00:00:00.000Z', 'other-channel'));
	await audit('reject', 'system', '2026-01-02T00:00:00.000Z');

	await expectNoReplayedIntent();
});

test('an unsupported bound user action never falls back to an older destructive intent', async () => {
	await audit('delete', 'user', '2026-01-01T00:00:00.000Z');
	await bind(await audit('dry-run', 'user', '2026-01-02T00:00:00.000Z'));
	await audit('approve', 'system', '2026-01-03T00:00:00.000Z');

	await expectNoReplayedIntent();
});

test('an unbound legacy restore never replays an unrelated historical ban', async () => {
	await audit('ban', 'user', '2025-12-01T00:00:00.000Z');
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		await expectNoReplayedIntent();
		expect(warning).toHaveBeenCalledWith(expect.stringContaining('owner retry required'), 'comment');
	} finally {
		warning.mockRestore();
	}
});

test('recovery uses the bound restore even when a later user audit says ban', async () => {
	await bind(await audit('restore', 'user', '2026-01-01T00:00:00.000Z'));
	await audit('ban', 'user', '2026-01-02T00:00:00.000Z');
	await reconcile();
	expect(youtube.setModerationStatus).toHaveBeenCalledExactlyOnceWith(['comment'], 'published', false, 'access-token', undefined);
	expect(await comment()).toMatchObject({ status: 'approved', restoreIntentId: null });
});

test.each(['missing audit', 'system actor', 'another comment'])('an invalid binding (%s) never falls back to historical ban', async (kind) => {
	const invalidId = await audit('restore', kind === 'system actor' ? 'system' : 'user', '2026-01-01T00:00:00.000Z', 'channel', kind === 'another comment' ? 'other-comment' : 'comment');
	await bind(kind === 'missing audit' ? 999999 : invalidId);
	await audit('ban', 'user', '2026-01-02T00:00:00.000Z');
	await expectNoReplayedIntent();
});

test('stale finalization cannot clear a newer restoring claim', async () => {
	const oldId = await audit('restore', 'user', '2026-01-01T00:00:00.000Z');
	const newId = await audit('reject', 'user', '2026-01-02T00:00:00.000Z');
	await bind(newId);
	await testDb().db.insert(moderationActions).values({ channelId: 'channel', commentId: 'comment', action: 'reject', reason: 'Completed replacement', state: 'completed' });
	await finalizeHumanIntent('channel', 'comment', 'restore', oldId);
	expect(await comment()).toMatchObject({ status: 'restoring', restoreIntentId: newId });
	expect((await testDb().db.select().from(moderationActions).get())?.state).toBe('cancelling');
	expect((await testDb().db.select().from(auditLog).all()).map((row) => row.id)).toEqual([oldId, newId]);
});
