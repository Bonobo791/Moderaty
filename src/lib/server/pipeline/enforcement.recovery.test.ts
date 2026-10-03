import { beforeEach, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, comments, moderationActions } from '$lib/server/db/schema';

const youtube = vi.hoisted(() => ({ setModerationStatus: vi.fn(), deleteComment: vi.fn() }));
vi.mock('$lib/server/youtube', async (importOriginal) => ({
	...await importOriginal<typeof import('$lib/server/youtube')>(),
	...youtube
}));

import { runEnforcement } from './enforcement';

setupTestDb(['channels', 'comments', 'audit_log', 'moderation_actions']);

beforeEach(async () => {
	vi.clearAllMocks();
	await testDb().db.insert(channels).values({ id: 'channel', title: 'Test channel', refreshTokenEnc: 'enc' });
	await testDb().db.insert(comments).values({
		id: 'comment', channelId: 'channel', text: 'Comment', publishedAt: '2026-01-01T00:00:00.000Z', status: 'restoring', decidedBy: 'human'
	});
});

async function audit(action: string, actor: string, createdAt: string, channelId = 'channel') {
	return testDb().db.insert(auditLog).values({ channelId, commentId: 'comment', action, actor, reason: 'Recovery fixture', createdAt });
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
	await audit(action, 'user', '2026-01-01T00:00:00.000Z');
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

test.each(['later timestamp', 'same timestamp'])('replays the latest human intent by %s even with a newer system row', async (ordering) => {
	await audit('approve', 'user', '2026-01-01T00:00:00.000Z');
	await audit('reject', 'user', ordering === 'same timestamp' ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z');
	await audit('approve', 'system', '2026-01-03T00:00:00.000Z');

	await reconcile();

	expect(youtube.setModerationStatus).toHaveBeenCalledExactlyOnceWith(['comment'], 'rejected', false, 'access-token', undefined);
	expect((await comment())?.status).toBe('rejected');
});

test('does not reuse a human intent from another channel', async () => {
	await audit('approve', 'user', '2026-01-01T00:00:00.000Z', 'other-channel');
	await audit('reject', 'system', '2026-01-02T00:00:00.000Z');

	await expectNoReplayedIntent();
});

test('an unsupported latest user action never falls back to an older destructive intent', async () => {
	await audit('delete', 'user', '2026-01-01T00:00:00.000Z');
	await audit('dry-run', 'user', '2026-01-02T00:00:00.000Z');
	await audit('approve', 'system', '2026-01-03T00:00:00.000Z');

	await expectNoReplayedIntent();
});
