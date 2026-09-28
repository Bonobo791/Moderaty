// Real-DB coverage for stageDecisions' rescan mode: the mock-db pipeline
// suites record write INTENT, but only SQLite can prove the upsert actually
// replaces a stored row, that a completed action re-pends, and that the
// charge anchors scope per requested scan.
import { eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	refreshAccessToken: vi.fn(),
	fetchNewComments: vi.fn(),
	fetchVideoMetadata: vi.fn(),
	getCommentModerationStatus: vi.fn(),
	setModerationStatus: vi.fn(),
	deleteComment: vi.fn()
}));

// staging → enforcement → youtube: only the network surface is stubbed (the
// rescan path never calls it — assertChannelActive is a pure db guard).
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: mocks.refreshAccessToken,
	fetchNewComments: mocks.fetchNewComments,
	fetchVideoMetadata: mocks.fetchVideoMetadata,
	getCommentModerationStatus: mocks.getCommentModerationStatus,
	setModerationStatus: mocks.setModerationStatus,
	deleteComment: mocks.deleteComment,
	YOUTUBE_ID_BATCH_SIZE: 50
}));

import { setupTestDb, testDb } from '../testdb';
import { auditLog, channels, comments, creditTransactions, moderationActions, organizations } from '../db/schema';
import { stageDecisions } from './staging';
import type { Decision } from './types';

setupTestDb(['audit_log', 'moderation_actions', 'comments', 'channels', 'credit_transactions', 'organizations']);

const IDENTITY = { userId: 'user-1', refreshTokenEnc: 'enc' };

async function seedChannelAndOrg(credits: number | null) {
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'Org', creditsRemaining: credits });
	await testDb().db.insert(channels).values({ id: 'UC1', userId: 'user-1', orgId: 'org-1', title: 'Ch', refreshTokenEnc: 'enc' });
}

function holdDecision(overrides: Partial<Decision> = {}): Decision {
	return {
		comment: {
			id: 'c1',
			threadId: 't1',
			videoId: 'v1',
			authorChannelId: 'a1',
			authorName: '@Ann',
			text: 'rescan text',
			publishedAt: '2024-01-01T00:00:00.000Z'
		},
		status: 'held',
		decidedBy: 'ai',
		matchedRuleId: null,
		aiScore: '{}',
		auditAction: 'queue',
		reason: 'ai score 0.9',
		youtubeAction: 'hold',
		billable: true,
		...overrides
	};
}

async function orgBalance() {
	return (await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.creditsRemaining;
}

test('a rescan upserts the stored comment, re-pends its completed action, and charges under the scan id', async () => {
	await seedChannelAndOrg(10);
	await testDb().db.insert(comments).values({
		id: 'c1', channelId: 'UC1', text: 'old text', publishedAt: '2024-01-01T00:00:00.000Z',
		status: 'approved', decidedBy: 'ai', feedbackDigestedAt: '2025-01-01T00:00:00.000Z'
	});
	await testDb().db.insert(moderationActions).values({
		commentId: 'c1', channelId: 'UC1', action: 'reject', reason: 'old reason',
		state: 'completed', lastAttemptAt: '2025-01-02T00:00:00.000Z', lastManualRetryAt: '2025-01-03T00:00:00.000Z'
	});
	// The earlier live-run charge anchor survives: a rescan is a NEW charge,
	// never a replay of the first analysis.
	await testDb().db.insert(creditTransactions).values({
		orgId: 'org-1', delta: -1, reason: 'consume', refType: 'comment', refId: 'c1', balanceAfter: 10
	});

	await stageDecisions('UC1', [holdDecision()], 'org-1', IDENTITY, 'scan-1');

	const stored = await testDb().db.select().from(comments).all();
	expect(stored).toHaveLength(1);
	// Fresh verdict + refreshed text; the feedback-digest marker is untouched
	// (the upsert column list excludes it and createdAt on purpose).
	expect(stored[0]).toMatchObject({
		id: 'c1', text: 'rescan text', status: 'held', decidedBy: 'ai', feedbackDigestedAt: '2025-01-01T00:00:00.000Z'
	});
	const actions = await testDb().db.select().from(moderationActions).all();
	// One action row per comment: the rescan's verdict replaces the completed
	// one and returns to pending so enforcement re-applies it.
	expect(actions).toHaveLength(1);
	expect(actions[0]).toMatchObject({
		commentId: 'c1', action: 'hold', reason: 'ai score 0.9', state: 'pending', lastAttemptAt: null, lastManualRetryAt: null
	});
	expect(await testDb().db.select().from(auditLog).all()).toEqual([
		expect.objectContaining({ commentId: 'c1', action: 'queue', reason: 'ai score 0.9' })
	]);
	const ledger = await testDb().db.select().from(creditTransactions).all();
	expect(ledger.map((row) => row.refId).sort()).toEqual(['c1', 'c1#scan-1']);
	expect(await orgBalance()).toBe(9);
});

test('a retry of the SAME rescan hits its anchors and debits nothing new', async () => {
	// Mid-drain retry after a crash: the first attempt's committed anchors
	// cover the same comments — staging re-runs harmlessly without a second
	// charge (I4).
	await seedChannelAndOrg(10);

	await stageDecisions('UC1', [holdDecision()], 'org-1', IDENTITY, 'scan-1');
	await stageDecisions('UC1', [holdDecision()], 'org-1', IDENTITY, 'scan-1');

	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(1);
	expect(await orgBalance()).toBe(9);
	expect(await testDb().db.select().from(comments).all()).toHaveLength(1);
});

test('a DIFFERENT scan id on the same comment is a fresh debit — re-runs are never silently free', async () => {
	// The owner re-requested the identical window; a new scan id mints new
	// anchors so each requested analysis debits once per comment.
	await seedChannelAndOrg(10);

	await stageDecisions('UC1', [holdDecision()], 'org-1', IDENTITY, 'scan-1');
	await stageDecisions('UC1', [holdDecision()], 'org-1', IDENTITY, 'scan-2');

	const ledger = await testDb().db.select().from(creditTransactions).all();
	expect(ledger.map((row) => row.refId).sort()).toEqual(['c1#scan-1', 'c1#scan-2']);
	expect(await orgBalance()).toBe(8);
});

test('a rescan verdict with no action supersedes the comment\'s outstanding staged actions — terminal rows stay', async () => {
	// The earlier verdict staged a pending reject on c1 and a dispatched
	// delete on c2; c3's action already completed. The fresh rescan verdict
	// approves all three. Outstanding intent must be cancelled — otherwise
	// the next enforcement sweep claims the stale row and applies the OLD
	// moderation decision on YouTube against the new verdict (codeant).
	// A completed row is settled history: the remote action really happened,
	// so it stays completed instead of being rewritten.
	await seedChannelAndOrg(10);
	await testDb().db.insert(comments).values([
		{ id: 'c1', channelId: 'UC1', text: 'one', publishedAt: '2024-01-01T00:00:00.000Z', status: 'pending', decidedBy: 'ai' },
		{ id: 'c2', channelId: 'UC1', text: 'two', publishedAt: '2024-01-01T00:00:00.000Z', status: 'held', decidedBy: 'ai' },
		{ id: 'c3', channelId: 'UC1', text: 'three', publishedAt: '2024-01-01T00:00:00.000Z', status: 'rejected', decidedBy: 'ai' }
	]);
	await testDb().db.insert(moderationActions).values([
		{ commentId: 'c1', channelId: 'UC1', action: 'reject', reason: 'old verdict', state: 'pending' },
		{ commentId: 'c2', channelId: 'UC1', action: 'delete', reason: 'old verdict', state: 'dispatched', lastAttemptAt: '2025-01-02T00:00:00.000Z' },
		{ commentId: 'c3', channelId: 'UC1', action: 'reject', reason: 'old verdict', state: 'completed', lastAttemptAt: '2025-01-02T00:00:00.000Z' }
	]);
	const approve = (id: string): Decision => ({
		comment: { id, threadId: 't', videoId: 'v', authorChannelId: 'a', authorName: '@Ann', text: 'rescan text', publishedAt: '2024-01-01T00:00:00.000Z' },
		status: 'approved', decidedBy: 'ai', matchedRuleId: null, aiScore: '{}',
		auditAction: 'approve', reason: 'ai score 0.1', youtubeAction: null, billable: true
	});

	await stageDecisions('UC1', [approve('c1'), approve('c2'), approve('c3')], 'org-1', IDENTITY, 'scan-1');

	const actions = await testDb().db.select().from(moderationActions).all();
	expect(new Map(actions.map((row) => [row.commentId, row.state]))).toEqual(
		new Map([['c1', 'superseded'], ['c2', 'superseded'], ['c3', 'completed']])
	);
});

test('a live run keeps the plain comment anchor', async () => {
	// Outside a rescan the anchor is the bare comment id — the same anchor a
	// LATER rescan deliberately does NOT share (a fresh request is a fresh
	// charge, never a replay of the first analysis).
	await seedChannelAndOrg(10);

	await stageDecisions('UC1', [holdDecision()], 'org-1', IDENTITY);

	const ledger = await testDb().db.select().from(creditTransactions).all();
	expect(ledger).toHaveLength(1);
	expect(ledger[0]).toMatchObject({ refType: 'comment', refId: 'c1' });
	expect(await orgBalance()).toBe(9);
});

test('a rescan on an exhausted balance aborts the whole staging transaction — nothing stages free', async () => {
	// creditsRemaining 0 is still metered (billing was engaged once): the
	// charge fails, no anchor exists, and the rollback leaves the stored row
	// untouched for the post-top-up retry.
	await seedChannelAndOrg(0);
	await testDb().db.insert(comments).values({
		id: 'c1', channelId: 'UC1', text: 'old text', publishedAt: '2024-01-01T00:00:00.000Z', status: 'approved', decidedBy: 'ai'
	});

	await expect(stageDecisions('UC1', [holdDecision()], 'org-1', IDENTITY, 'scan-1')).rejects.toThrow('credit charge failed for comment c1');

	expect((await testDb().db.select().from(comments).get())?.status).toBe('approved');
	expect(await testDb().db.select().from(moderationActions).all()).toHaveLength(0);
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(0);
	expect(await orgBalance()).toBe(0);
});
