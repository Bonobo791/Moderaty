import { eq } from 'drizzle-orm';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	decrypt: vi.fn((value: string) => `plain:${value}`),
	refreshAccessToken: vi.fn(async () => 'access-token'),
	fetchNewComments: vi.fn()
}));

vi.mock('$lib/server/crypto', () => ({ decrypt: mocks.decrypt }));
vi.mock('$lib/server/youtube', () => ({ refreshAccessToken: mocks.refreshAccessToken, fetchNewComments: mocks.fetchNewComments }));

import { setupTestDb, testDb } from './testdb';
import { channels, comments, feedbackHistoryComments } from './db/schema';
import { advanceFeedbackHistory, fetchFeedbackPage, pendingStoredFeedback } from './feedbackHistory';

setupTestDb(['comments', 'feedback_history_comments', 'channels']);

async function seedChannel(over: Record<string, unknown> = {}) {
	await testDb().db.insert(channels).values({
		id: 'UC1', userId: 'user-1', orgId: 'org-1', title: 'Channel', refreshTokenEnc: 'enc',
		feedbackHistoryBoundary: '2026-01-01T00:00:00.000Z', ...over
	});
	return (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
}

function ytComment(id: string, text: string, publishedAt: string) {
	return { id, text, publishedAt, authorName: 'private author', authorChannelId: 'private channel' };
}

beforeEach(() => {
	mocks.refreshAccessToken.mockReset().mockResolvedValue('access-token');
	mocks.fetchNewComments.mockReset();
	mocks.decrypt.mockClear();
});

test('fetchFeedbackPage requests exactly one YouTube page and returns chronological, deduplicated, capped sources', async () => {
	const channel = await seedChannel();
	const longText = 'x'.repeat(510);
	mocks.fetchNewComments.mockResolvedValue({
		comments: [
			ytComment('later', 'later comment', '2026-01-02T00:00:00.000Z'),
			ytComment('offset', 'offset comment', '2026-01-03T01:00:00+05:30'),
			ytComment('first', longText, '2026-01-01T00:00:00.000Z'),
			ytComment('first', 'duplicate ignored', '2026-01-01T00:00:00.000Z')
		],
		nextPageToken: 'page-next',
		reachedCursor: false
	});

	const page = await fetchFeedbackPage(channel, '2026-01-01T00:00:00.000Z', 'page-start', 12345);

	expect(mocks.refreshAccessToken).toHaveBeenCalledWith('plain:enc', 12345);
	expect(mocks.fetchNewComments).toHaveBeenCalledWith('UC1', 'access-token', '2026-01-01T00:00:00.000Z', {
		maxPages: 1, pageToken: 'page-start', deadline: 12345
	});
	expect(page).toEqual({
		batch: [
			{ id: 'first', text: 'x'.repeat(500), publishedAt: '2026-01-01T00:00:00.000Z' },
			{ id: 'later', text: 'later comment', publishedAt: '2026-01-02T00:00:00.000Z' },
			{ id: 'offset', text: 'offset comment', publishedAt: '2026-01-03T01:00:00+05:30' }
		],
		nextPageToken: 'page-next',
		complete: false
	});
	expect(JSON.stringify(page)).not.toContain('private author');
	expect(JSON.stringify(page)).not.toContain('private channel');
});

test('fetchFeedbackPage throws rather than silently truncating an oversized page', async () => {
	const channel = await seedChannel();
	mocks.fetchNewComments.mockResolvedValue({
		comments: Array.from({ length: 101 }, (_, index) => ytComment(`c${index}`, `text ${index}`, '2026-01-01T00:00:00.000Z')),
		nextPageToken: 'page-2',
		reachedCursor: false
	});

	await expect(fetchFeedbackPage(channel, channel.feedbackHistoryBoundary!, null)).rejects.toThrow('exceeded 100 comments');
});

test('fetchFeedbackPage returns every comment on the page — completed stored and historical IDs are re-analyzed, never filtered', async () => {
	// Repeatable history analysis is the feature: a re-requested window must
	// re-classify comments the digest or a previous history run already
	// covered. Coverage markers no longer prune the batch — the charge
	// anchors (scoped per scan) are what keep retries idempotent.
	const channel = await seedChannel({ feedbackHistoryPageToken: 'page-2' });
	await testDb().db.insert(comments).values({
		id: 'stored-done', channelId: 'UC1', text: 'already covered', publishedAt: '2025-01-01T00:00:00.000Z', status: 'approved', decidedBy: 'ai', feedbackDigestedAt: '2026-01-01T00:00:00.000Z'
	});
	await testDb().db.insert(feedbackHistoryComments).values({ id: 'history-done', channelId: 'UC1', text: 'already historical', publishedAt: '2025-01-02T00:00:00.000Z' });
	mocks.fetchNewComments.mockResolvedValue({
		comments: [
			ytComment('stored-done', 'already covered', '2025-01-01T00:00:00.000Z'),
			ytComment('history-done', 'already historical', '2025-01-02T00:00:00.000Z'),
			ytComment('pending', 'new source', '2025-01-03T00:00:00.000Z')
		],
		nextPageToken: 'page-3',
		reachedCursor: false
	});

	const page = await fetchFeedbackPage(channel, channel.feedbackHistoryBoundary!, 'page-2', 99);

	expect(mocks.fetchNewComments).toHaveBeenCalledWith('UC1', 'access-token', channel.feedbackHistoryBoundary, {
		maxPages: 1, pageToken: 'page-2', deadline: 99
	});
	expect(page.batch).toEqual([
		{ id: 'stored-done', text: 'already covered', publishedAt: '2025-01-01T00:00:00.000Z' },
		{ id: 'history-done', text: 'already historical', publishedAt: '2025-01-02T00:00:00.000Z' },
		{ id: 'pending', text: 'new source', publishedAt: '2025-01-03T00:00:00.000Z' }
	]);
});

test('pendingStoredFeedback excludes IDs already completed from YouTube history', async () => {
	await seedChannel();
	await testDb().db.insert(comments).values([
		{ id: 'pending', channelId: 'UC1', text: 'pending', publishedAt: '2026-01-01T00:00:00.000Z', status: 'approved', decidedBy: 'ai' },
		{ id: 'historical', channelId: 'UC1', text: 'historical', publishedAt: '2026-01-02T00:00:00.000Z', status: 'approved', decidedBy: 'ai' }
	]);
	await testDb().db.insert(feedbackHistoryComments).values({ id: 'historical', channelId: 'UC1', text: 'historical', publishedAt: '2026-01-02T00:00:00.000Z' });

	const rows = await testDb().db.select({ id: comments.id }).from(comments).where(pendingStoredFeedback('UC1')).all();

	expect(rows).toEqual([{ id: 'pending' }]);
});

test('advanceFeedbackHistory changes only feedback history checkpoints and rejects a stolen lease', async () => {
	const channel = await seedChannel({
		feedbackEnabled: 1,
		cursor: '2026-06-01T00:00:00.000Z', nextPageToken: 'moderation-page', scanCursor: 'scan',
		historyBoundary: '2025-01-01T00:00:00.000Z', historyNextPageToken: 'moderation-history-page',
		dryRunBoundary: '2026-03-01T00:00:00.000Z', dryRunPageToken: 'preview-page', leaseExpiresAt: '2099-01-01T00:00:00.000Z',
		feedbackHistoryScanId: 'scan-1'
	});
	const incomplete = { batch: [], nextPageToken: 'page-next', complete: false };
	await advanceFeedbackHistory(testDb().db, channel, incomplete);
	let updated = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(updated.feedbackHistoryBoundary).toBe(channel.feedbackHistoryBoundary);
	expect(updated.feedbackHistoryPageToken).toBe('page-next');
	expect(updated.feedbackHistoryScanId).toBe('scan-1');
	expect(updated).toMatchObject({
		cursor: channel.cursor, nextPageToken: channel.nextPageToken, scanCursor: channel.scanCursor,
		historyBoundary: channel.historyBoundary, historyNextPageToken: channel.historyNextPageToken,
		dryRunBoundary: channel.dryRunBoundary, dryRunPageToken: channel.dryRunPageToken
	});

	// Completing clears the whole scan state together — boundary, page token,
	// and the billing nonce — so a fresh request never inherits a stale scope.
	await advanceFeedbackHistory(testDb().db, updated, { batch: [], nextPageToken: null, complete: true });
	updated = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(updated).toMatchObject({ feedbackHistoryBoundary: null, feedbackHistoryPageToken: null, feedbackHistoryScanId: null });

	await testDb().db.update(channels).set({ feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryScanId: 'scan-2' }).where(eq(channels.id, 'UC1'));
	const replanted = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	await testDb().db.update(channels).set({ leaseExpiresAt: '2100-01-01T00:00:00.000Z' }).where(eq(channels.id, 'UC1'));
	await expect(advanceFeedbackHistory(testDb().db, replanted, { batch: [], nextPageToken: null, complete: true })).rejects.toThrow('checkpoint changed');
	updated = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(updated).toMatchObject({ feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryScanId: 'scan-2' });
});

test('advanceFeedbackHistory rejects a stale scan id even when boundary and page token are unchanged', async () => {
	// The owner replants the SAME window while a worker from the previous
	// scan is still finishing: boundary and pageToken can coincide between
	// the two scans, so the scan id is the only field that distinguishes
	// them. A stale completion must never clear the new scan (codeant).
	const channel = await seedChannel({ feedbackEnabled: 1, feedbackHistoryScanId: 'scan-1', leaseExpiresAt: '2099-01-01T00:00:00.000Z' });
	// Replant: identical boundary and page token, fresh scan nonce.
	await testDb().db
		.update(channels)
		.set({ feedbackHistoryScanId: 'scan-2' })
		.where(eq(channels.id, 'UC1'));

	await expect(
		advanceFeedbackHistory(testDb().db, channel, { batch: [], nextPageToken: null, complete: true })
	).rejects.toThrow('checkpoint changed');

	const updated = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(updated).toMatchObject({
		feedbackHistoryBoundary: channel.feedbackHistoryBoundary,
		feedbackHistoryScanId: 'scan-2'
	});
});

test('advanceFeedbackHistory aborts when the channel was paused or feedback disabled mid-scan', async () => {
	// A pause or feedback opt-out mid-scan must abort the commit, exactly like
	// assertChannelActive does for moderation writes — otherwise the page the
	// owner asked to stop still advances the durable history checkpoint.
	const channel = await seedChannel({ feedbackEnabled: 1, leaseExpiresAt: '2099-01-01T00:00:00.000Z' });
	const page = { batch: [], nextPageToken: 'page-next', complete: false };

	await testDb().db.update(channels).set({ active: 0 }).where(eq(channels.id, 'UC1'));
	await expect(advanceFeedbackHistory(testDb().db, channel, page)).rejects.toThrow('checkpoint changed');

	await testDb().db.update(channels).set({ active: 1, feedbackEnabled: 0 }).where(eq(channels.id, 'UC1'));
	await expect(advanceFeedbackHistory(testDb().db, channel, page)).rejects.toThrow('checkpoint changed');

	const updated = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(updated.feedbackHistoryPageToken).toBeNull();
});
