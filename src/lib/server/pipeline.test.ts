// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const state = {
		env: { DRY_RUN: 'false' } as Record<string, string | undefined>,
		tables: {
			channels: undefined as unknown,
			comments: undefined as unknown,
			rules: undefined as unknown,
			auditLog: undefined as unknown,
			moderationActions: undefined as unknown
		},
		channel: {} as Record<string, unknown>,
		channelUpdates: [] as Record<string, unknown>[],
		existingIds: [] as string[],
		unclaimedIds: [] as string[],
		ruleRows: [] as unknown[],
		insertedComments: [] as Record<string, unknown>[],
		insertedAudits: [] as Record<string, unknown>[],
		moderationActions: [] as Record<string, unknown>[]
	};
	const store = (table: unknown, values: unknown) => {
		const rows = (Array.isArray(values) ? values : [values]) as Record<string, unknown>[];
		if (table === state.tables.comments) state.insertedComments.push(...rows);
		if (table === state.tables.auditLog) state.insertedAudits.push(...rows);
		if (table === state.tables.moderationActions) state.moderationActions.push(...rows);
	};
	const query = (table: unknown) => ({
		where: () => ({
			get: async () => {
				if (table === state.tables.channels) return state.channel;
				throw new Error('unexpected get query');
			},
			all: async () => {
				if (table === state.tables.comments) {
					return [...new Set([
						...state.existingIds,
						...state.insertedComments.map((comment) => String(comment.id))
					])].map((id) => ({ id }));
				}
				if (table === state.tables.rules) return state.ruleRows;
				if (table === state.tables.moderationActions) {
					return state.moderationActions.filter((action) => action.state === 'pending' || action.state === 'dispatched');
				}
				throw new Error('unexpected all query');
			}
		})
	});
	const transaction = {
		insert: (table: unknown) => ({ values: async (values: unknown) => store(table, values) }),
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: () => {
					const none = { returning: async () => [] as Record<string, unknown>[] };
					if (table === state.tables.channels) {
						state.channelUpdates.push(values);
						return none;
					}
					if (table !== state.tables.moderationActions || !('state' in values)) return none;
					if (values.state === 'dispatched' && !('lastAttemptAt' in values)) {
						// Atomic claim: only pending rows transition, and the claimed ids
						// come back via RETURNING. Ids in unclaimedIds simulate a
						// concurrent run that claimed the row first.
						const claimed = state.moderationActions.filter((item) =>
							item.state === 'pending' && !state.unclaimedIds.includes(String(item.commentId)));
						claimed.forEach((item) => {
							Object.assign(item, values);
						});
						return { returning: async () => claimed.map((item) => ({ commentId: item.commentId })) };
					}
					const action = state.moderationActions.find((item) => {
						if (values.state === 'dispatched') return item.state === 'pending';
						return item.state === 'dispatched';
					});
					if (action) Object.assign(action, values);
					return none;
				}
			})
		})
	};

	return {
		state,
		db: {
			select: vi.fn(() => ({ from: (table: unknown) => query(table) })),
			insert: vi.fn((table: unknown) => ({ values: async (values: unknown) => store(table, values) })),
			transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
			update: vi.fn((table: unknown) => transaction.update(table)),
			transactionValue: transaction
		},
		decrypt: vi.fn(),
		assertBeforeDeadline: vi.fn(),
		refreshAccessToken: vi.fn(),
		fetchNewComments: vi.fn(),
		fetchVideoMetadata: vi.fn(),
		getCommentModerationStatus: vi.fn(),
		setModerationStatus: vi.fn(),
		deleteComment: vi.fn(),
		scoreComment: vi.fn(),
		serializeScores: vi.fn(),
		scoreTone: vi.fn(),
		checkSync: vi.fn(() => ({ status: 'safe' })),
		DeadlineExceededError: class DeadlineExceededError extends Error {}
	};
});

vi.mock('recheck', () => ({ checkSync: mocks.checkSync }));
vi.mock('$lib/server/crypto', () => ({ decrypt: mocks.decrypt }));
vi.mock('$lib/server/db', () => ({ db: mocks.db }));
vi.mock('$env/dynamic/private', () => ({ env: mocks.state.env }));
vi.mock('$lib/server/http', () => ({
	assertBeforeDeadline: mocks.assertBeforeDeadline,
	DeadlineExceededError: mocks.DeadlineExceededError
}));
vi.mock('$lib/server/moderation', () => ({
	scoreComment: mocks.scoreComment,
	serializeScores: mocks.serializeScores
}));
vi.mock('$lib/server/tone', () => ({
	scoreTone: mocks.scoreTone
}));
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: mocks.refreshAccessToken,
	fetchNewComments: mocks.fetchNewComments,
	fetchVideoMetadata: mocks.fetchVideoMetadata,
	getCommentModerationStatus: mocks.getCommentModerationStatus,
	setModerationStatus: mocks.setModerationStatus,
	deleteComment: mocks.deleteComment
}));

import { auditLog, channels, comments, moderationActions, rules } from '$lib/server/db/schema';
import { runChannel } from './pipeline';
import type { NewComment } from './youtube';

const originalDryRun = process.env.DRY_RUN;

function newComment(overrides: Partial<NewComment> = {}): NewComment {
	return {
		id: 'comment',
		threadId: 'thread',
		videoId: 'video',
		authorChannelId: 'author',
		authorName: 'Author',
		text: 'A comment',
		publishedAt: '2026-01-04T00:00:00.000Z',
		...overrides
	};
}

function moderation(score: number) {
	return {
		score,
		scores: {
			harassment: score,
			'harassment/threatening': score,
			hate: score,
			'hate/threatening': score,
			violence: score,
			'violence/graphic': score
		}
	};
}

function dispatchedAction(overrides: Record<string, unknown> = {}) {
	return {
		commentId: 'comment',
		channelId: 'channel',
		action: 'ban',
		reason: 'rule #1 (user: author)',
		state: 'dispatched',
		lastAttemptAt: '2026-01-04T00:00:00.000Z',
		lastManualRetryAt: null,
		createdAt: '2026-01-04T00:00:00.000Z',
		...overrides
	};
}

function expectActionState(state: string) {
	expect(mocks.state.moderationActions).toEqual([expect.objectContaining({ commentId: 'comment', state })]);
}

function expectAiUnavailableQueued(result: unknown, extra: Record<string, unknown> = {}) {
	expect(mocks.state.insertedComments).toEqual([
		expect.objectContaining({ id: 'comment', status: 'pending', decidedBy: 'none', aiScore: null })
	]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'queue', reason: expect.stringContaining('ai unavailable') })
	]);
	expect(result).toMatchObject({ acted: 0, queued: 1, ...extra });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.state.tables = { channels, comments, rules, auditLog, moderationActions };
	mocks.state.env.DRY_RUN = 'false';
	mocks.state.channel = {
		id: 'channel',
		title: 'Channel',
		refreshTokenEnc: 'encrypted-refresh-token',
		cursor: null,
		nextPageToken: null,
		scanCursor: null,
		active: 1,
		toneLevel: null,
		createdAt: '2026-01-01T00:00:00.000Z'
	};
	mocks.state.channelUpdates = [];
	mocks.state.existingIds = [];
	mocks.state.unclaimedIds = [];
	mocks.state.ruleRows = [];
	mocks.state.insertedComments = [];
	mocks.state.insertedAudits = [];
	mocks.state.moderationActions = [];
	mocks.decrypt.mockReturnValue('refresh-token');
	mocks.refreshAccessToken.mockResolvedValue('access-token');
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment()],
		nextPageToken: null,
		reachedCursor: true
	});
	mocks.setModerationStatus.mockResolvedValue(undefined);
	mocks.deleteComment.mockResolvedValue(undefined);
	mocks.getCommentModerationStatus.mockResolvedValue('rejected');
	mocks.serializeScores.mockReturnValue('{}');
	mocks.scoreTone.mockResolvedValue({ score: 0 });
	mocks.fetchVideoMetadata.mockResolvedValue(new Map([
		['video', { title: 'Video title', description: 'Video description' }]
	]));
	process.env.DRY_RUN = 'false';
});

afterEach(() => {
	if (originalDryRun === undefined) delete process.env.DRY_RUN;
	else process.env.DRY_RUN = originalDryRun;
});

test.each([
	{ score: 0.5, status: 'approved', queued: 0, acted: 0, api: 'none', audit: 'approve' },
	{ score: 0.51, status: 'pending', queued: 1, acted: 0, api: 'none', audit: 'queue' },
	{ score: 0.75, status: 'pending', queued: 1, acted: 0, api: 'none', audit: 'queue' },
	{ score: 0.76, status: 'rejected', queued: 0, acted: 1, api: 'reject', audit: 'reject' },
	{ score: 0.94, status: 'rejected', queued: 0, acted: 1, api: 'reject', audit: 'reject' },
	{ score: 0.95, status: 'rejected', queued: 0, acted: 1, api: 'ban', audit: 'ban' }
])('categorizes score $score as $status', async ({ score, status, queued, acted, api, audit }) => {
	mocks.scoreComment.mockResolvedValue(moderation(score));

	const result = await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status })]);
	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({ commentId: 'comment', action: audit })]);
	if (api === 'delete') {
		expect(mocks.deleteComment).toHaveBeenCalledWith('comment', 'access-token', undefined);
		expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	} else if (api === 'reject') {
		expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
		expect(mocks.deleteComment).not.toHaveBeenCalled();
	} else if (api === 'ban') {
		expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', true, 'access-token', undefined);
		expect(mocks.deleteComment).not.toHaveBeenCalled();
	} else {
		expect(mocks.setModerationStatus).not.toHaveBeenCalled();
		expect(mocks.deleteComment).not.toHaveBeenCalled();
	}
	expect(result).toMatchObject({ fetched: 1, acted, queued, partial: false, skipped: false, dryRun: false });
});

test('validates and compiles each regex rule once per run, not per comment', async () => {
	mocks.state.ruleRows = [{ id: 1, type: 'regex', pattern: 'spam', action: 'hold' }];
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ id: 'a', text: 'spam one' }), newComment({ id: 'b', text: 'spam two' })],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.checkSync).toHaveBeenCalledTimes(1);
});

test('routes AI scoring failures to the review queue instead of failing the run (I11)', async () => {
	mocks.scoreComment.mockRejectedValue(new Error('moderation response has missing or out-of-range category scores'));

	const result = await runChannel('channel');

	expectAiUnavailableQueued(result, { fetched: 1, partial: false, skipped: false });
});

test.each([
	{ toneLevel: null },
	{ toneLevel: 1 }
])('never calls the tone classifier at sensitivity level $toneLevel', async ({ toneLevel }) => {
	mocks.state.channel.toneLevel = toneLevel;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));

	await runChannel('channel');

	expect(mocks.fetchVideoMetadata).not.toHaveBeenCalled();
	expect(mocks.scoreTone).not.toHaveBeenCalled();
	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status: 'approved' })]);
});

test('rejects a demeaning comment the omni score alone would approve', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.scoreTone.mockResolvedValue({ score: 0.82 });

	const result = await runChannel('channel');

	expect(mocks.scoreTone).toHaveBeenCalledWith(
		'A comment',
		{ videoTitle: 'Video title', videoDescription: 'Video description' },
		undefined
	);
	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status: 'rejected' })]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'reject', reason: 'tone score 0.82' })
	]);
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
	expect(result).toMatchObject({ acted: 1, queued: 0 });
});

test('bans the author of a genuinely harmful tone attack (≥0.95)', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.scoreTone.mockResolvedValue({ score: 0.97 });

	await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status: 'rejected' })]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'ban', reason: 'tone score 0.97' })
	]);
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', true, 'access-token', undefined);
});

test('queues a borderline tone score (0.51–0.75)', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.scoreTone.mockResolvedValue({ score: 0.6 });

	const result = await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status: 'pending' })]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'queue', reason: 'tone score 0.60' })
	]);
	expect(result).toMatchObject({ acted: 0, queued: 1 });
});

test('keeps the omni outcome when it is the stronger signal', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.6));
	mocks.scoreTone.mockResolvedValue({ score: 0.2 });

	await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status: 'pending' })]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'queue', reason: 'ai score 0.60' })
	]);
});

test('skips the tone call entirely when the omni score already rejects', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.8));

	await runChannel('channel');

	expect(mocks.scoreTone).not.toHaveBeenCalled();
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
});

test('routes tone scoring failures to the review queue (I11)', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.scoreTone.mockRejectedValue(new Error('tone response has missing or out-of-range score'));

	const result = await runChannel('channel');

	expectAiUnavailableQueued(result);
});

test('routes video metadata failures to the review queue instead of aborting the run (I11)', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.fetchVideoMetadata.mockRejectedValue(new Error('videos.list failed with 500'));

	const result = await runChannel('channel');

	expectAiUnavailableQueued(result);
	expect(mocks.scoreTone).not.toHaveBeenCalled();
});

test('scores tone with empty context when a comment has no video ID', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.scoreTone.mockResolvedValue({ score: 0.2 });
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ videoId: null })],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.fetchVideoMetadata).not.toHaveBeenCalled();
	expect(mocks.scoreTone).toHaveBeenCalledWith(
		'A comment',
		{ videoTitle: '', videoDescription: '' },
		undefined
	);
});

test('persists the chronologically newest timestamp when UTC offsets differ', async () => {
	mocks.scoreComment.mockResolvedValue(moderation(0));
	mocks.fetchNewComments.mockResolvedValue({
		comments: [
			// Lexicographically later but an older instant (2026-01-03T23:30:00Z).
			newComment({ id: 'offset', publishedAt: '2026-01-04T05:00:00+05:30' }),
			newComment({ id: 'newest', publishedAt: '2026-01-03T23:45:00.000Z' })
		],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.state.channelUpdates).toContainEqual(
		expect.objectContaining({ cursor: '2026-01-03T23:45:00.000Z' })
	);
});

test('does not call YouTube moderation or deletion APIs during a dry run', async () => {
	mocks.state.ruleRows = [{ id: 1, type: 'keyword', pattern: 'comment', action: 'delete' }];
	process.env.DRY_RUN = 'true';
	mocks.state.env.DRY_RUN = 'true';

	const result = await runChannel('channel');

	expect(mocks.scoreComment).not.toHaveBeenCalled();
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect(mocks.db.transaction).not.toHaveBeenCalled();
	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({
		commentId: 'comment',
		action: 'dry-run'
	})]);
	expect(result).toMatchObject({ fetched: 1, acted: 1, queued: 0, partial: false, skipped: false, dryRun: true });
});

test('reads DRY_RUN from private runtime environment variables', async () => {
	delete process.env.DRY_RUN;
	mocks.state.env.DRY_RUN = 'true';
	mocks.state.ruleRows = [{ id: 1, type: 'keyword', pattern: 'comment', action: 'delete' }];

	const result = await runChannel('channel');

	expect(result.dryRun).toBe(true);
	expect(mocks.deleteComment).not.toHaveBeenCalled();
});

test('writes an approval audit entry for a low-risk AI decision', async () => {
	mocks.scoreComment.mockResolvedValue(moderation(0.34));

	await runChannel('channel');

	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({
		commentId: 'comment',
		action: 'approve',
		reason: 'ai score 0.34'
	})]);
});

test('scores full comment text but truncates the stored copy', async () => {
	const text = 'x'.repeat(501);
	mocks.scoreComment.mockResolvedValue(moderation(0.34));
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ text })],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.scoreComment).toHaveBeenCalledWith(text, undefined);
	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ text: text.slice(0, 500) })]);
});

test('stores the comment text but never author identifiers', async () => {
	mocks.scoreComment.mockResolvedValue(moderation(0.1));

	await runChannel('channel');

	expect(mocks.state.insertedComments).toHaveLength(1);
	const stored = mocks.state.insertedComments[0] as Record<string, unknown>;
	expect(stored.text).toBe('A comment');
	expect(stored).not.toHaveProperty('authorName');
	expect(stored).not.toHaveProperty('authorChannelId');
});

test('records successful remote actions before a later action fails', async () => {
	mocks.state.ruleRows = [
		{ id: 1, type: 'keyword', pattern: 'hold', action: 'hold' },
		{ id: 2, type: 'keyword', pattern: 'reject', action: 'reject' }
	];
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ id: 'held', text: 'hold this' }), newComment({ id: 'rejected', text: 'reject this' })],
		nextPageToken: null,
		reachedCursor: true
	});
	mocks.setModerationStatus
		.mockResolvedValueOnce(undefined)
		.mockRejectedValueOnce(new Error('YouTube rejected request'));

	await expect(runChannel('channel')).rejects.toThrow('YouTube rejected request');

	expect(mocks.state.insertedComments).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: 'held', status: 'held' }),
		expect.objectContaining({ id: 'rejected', status: 'rejected' })
	]));
	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({ commentId: 'held', action: 'hold' })]);
});

test('queues AI scoring failures for human review and never rescores them (I11)', async () => {
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ id: 'good', text: 'good' }), newComment({ id: 'bad', text: 'bad' })],
		nextPageToken: 'next-page',
		reachedCursor: false
	});
	mocks.scoreComment.mockImplementation(async (text: string) => {
		if (text === 'bad') throw new Error('OpenAI overloaded');
		return moderation(0.34);
	});

	const first = await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: 'good', status: 'approved' }),
		expect.objectContaining({ id: 'bad', status: 'pending', decidedBy: 'none' })
	]));
	expect(mocks.state.insertedAudits).toEqual(expect.arrayContaining([
		expect.objectContaining({ commentId: 'bad', action: 'queue', reason: expect.stringContaining('ai unavailable') })
	]));
	expect(first).toMatchObject({ fetched: 2, queued: 1, partial: false, skipped: false, dryRun: false });

	mocks.scoreComment.mockClear();
	const second = await runChannel('channel');

	expect(mocks.scoreComment).not.toHaveBeenCalled();
	expect(second).toMatchObject({ partial: false, skipped: false, dryRun: false });
});

test('verifies a dispatched action after its completion transaction fails', async () => {
	mocks.state.ruleRows = [{ id: 1, type: 'keyword', pattern: 'comment', action: 'reject' }];
	mocks.db.transaction
		.mockImplementationOnce(async (callback: (value: typeof mocks.db.transactionValue) => Promise<unknown>) => callback(mocks.db.transactionValue))
		.mockRejectedValueOnce(new Error('database write failed'));

	await expect(runChannel('channel')).rejects.toThrow('database write failed');

	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(1);
	expectActionState('dispatched');

	await runChannel('channel');

	expect(mocks.getCommentModerationStatus).toHaveBeenCalledWith('comment', 'access-token', undefined);
	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(1);
	expectActionState('completed');
});

test.each([
	{ observed: 'rejected' as const },
	{ observed: null }
])('completes a dispatched ban when the comment is already terminal ($observed)', async ({ observed }) => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction()];
	mocks.getCommentModerationStatus.mockResolvedValue(observed);

	await runChannel('channel');

	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expectActionState('completed');
});

test('retries a dispatched ban while the comment is still public', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction()];
	mocks.getCommentModerationStatus.mockResolvedValue('published');

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', true, 'access-token', undefined);
	expectActionState('completed');
});

test.each([
	{ raw: 0.506, status: 'pending', reason: 'ai score 0.51' },
	{ raw: 0.504, status: 'approved', reason: 'ai score 0.50' }
])('rounds the AI score to 2 decimals before deciding ($raw → $status)', async ({ raw, status, reason }) => {
	mocks.scoreComment.mockResolvedValue(moderation(raw));

	await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status })]);
	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({ commentId: 'comment', reason })]);
});

test('keeps a dispatched action retriable when verification fails transiently', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction({ action: 'reject', reason: 'rule #1 (keyword)' })];
	mocks.getCommentModerationStatus.mockRejectedValueOnce(new Error('socket hang up'));

	await expect(runChannel('channel')).rejects.toThrow('verification failed');

	expectActionState('dispatched');

	await runChannel('channel');

	expect(mocks.getCommentModerationStatus).toHaveBeenCalledWith('comment', 'access-token', undefined);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expectActionState('completed');
});

test('stops without new writes or YouTube calls when account deletion deactivates the channel mid-run', async () => {
	mocks.scoreComment.mockImplementation(async () => {
		// Account deletion commits active = 0 while the run is scoring comments.
		mocks.state.channel = { ...mocks.state.channel, active: 0 };
		return moderation(0.95);
	});

	const result = await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([]);
	expect(mocks.state.insertedAudits).toEqual([]);
	expect(mocks.state.moderationActions).toEqual([]);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect(mocks.state.channelUpdates).toEqual([]);
	expect(result).toMatchObject({ fetched: 1, partial: true, dryRun: false });
});

test('does not dispatch staged enforcement when the channel is deactivated after decisions are staged', async () => {
	mocks.state.ruleRows = [{ id: 1, type: 'keyword', pattern: 'comment', action: 'reject' }];
	// Deletion commits during the staging transaction: the staged rows belong to
	// the pre-delete run, but no YouTube enforcement may follow.
	mocks.db.transaction.mockImplementationOnce(async (callback: (value: typeof mocks.db.transactionValue) => Promise<unknown>) => {
		mocks.state.channel = { ...mocks.state.channel, active: 0 };
		return callback(mocks.db.transactionValue);
	});

	const result = await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status: 'rejected' })]);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expectActionState('pending');
	expect(mocks.state.channelUpdates).toEqual([]);
	expect(result).toMatchObject({ partial: true });
});

test('skips a pending action already claimed by a concurrent run', async () => {
	mocks.state.ruleRows = [{ id: 1, type: 'keyword', pattern: 'comment', action: 'reject' }];
	mocks.state.unclaimedIds = ['comment'];

	const result = await runChannel('channel');

	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect(mocks.state.insertedAudits).toEqual([]);
	expectActionState('pending');
	expect(result).toMatchObject({ fetched: 1, acted: 0, skipped: false, dryRun: false });
});

test('decides a duplicated comment id only once when fetch pages overlap', async () => {
	// commentThreads pagination can repeat an item across page boundaries; the
	// dedupe against already-stored comments does not catch a duplicate within
	// the same batch, and two rows with one id violate the comments.id PRIMARY
	// KEY — failing the whole staging transaction (prod incident: history drain
	// 500ing on UNIQUE constraint failed: comments.id).
	mocks.scoreComment.mockResolvedValue(moderation(0.34));
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment(), newComment({ threadId: 'thread-2' })],
		nextPageToken: null,
		reachedCursor: true
	});

	const result = await runChannel('channel');

	expect(mocks.scoreComment).toHaveBeenCalledTimes(1);
	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status: 'approved' })]);
	expect(result).toMatchObject({ fetched: 2, acted: 0, skipped: false, dryRun: false });
});

test('rule delete action enforces deleteComment end-to-end', async () => {
	mocks.state.ruleRows = [{ id: 1, type: 'keyword', pattern: 'comment', action: 'delete' }];

	const result = await runChannel('channel');

	expect(mocks.state.moderationActions).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'delete', state: 'completed' })
	]);
	expect(mocks.deleteComment).toHaveBeenCalledWith('comment', 'access-token', undefined);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(result).toMatchObject({ fetched: 1, acted: 1, dryRun: false });
});

test('rule ban action rejects the comment with banAuthor set', async () => {
	mocks.state.ruleRows = [{ id: 1, type: 'keyword', pattern: 'comment', action: 'ban' }];

	const result = await runChannel('channel');

	expect(mocks.state.moderationActions).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'ban', state: 'completed' })
	]);
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', true, 'access-token', undefined);
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect(result).toMatchObject({ fetched: 1, acted: 1, dryRun: false });
});

test('rule hold action dispatches heldForReview to YouTube', async () => {
	mocks.state.ruleRows = [{ id: 1, type: 'keyword', pattern: 'comment', action: 'hold' }];

	const result = await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'heldForReview', false, 'access-token', undefined);
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect(result).toMatchObject({ fetched: 1, acted: 1, dryRun: false });
});

test('skips an inactive channel without fetching or scoring', async () => {
	mocks.state.channel = { ...mocks.state.channel, active: 0 };

	const result = await runChannel('channel');

	expect(result).toEqual({ fetched: 0, acted: 0, queued: 0, partial: false, skipped: true, dryRun: false });
	expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
	expect(mocks.fetchNewComments).not.toHaveBeenCalled();
	expect(mocks.scoreComment).not.toHaveBeenCalled();
});

test('fails loudly when DRY_RUN is not true or false', async () => {
	process.env.DRY_RUN = 'ture';
	mocks.state.env.DRY_RUN = 'ture';

	await expect(runChannel('channel')).rejects.toThrow('DRY_RUN must be true or false');

	expect(mocks.fetchNewComments).not.toHaveBeenCalled();
});

test('fails the run after staging when a comment decision throws, without advancing the cursor', async () => {
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ id: 'bad', text: 'bad' }), newComment({ id: 'good', text: 'good' })],
		nextPageToken: null,
		reachedCursor: true
	});
	mocks.scoreComment.mockImplementation(async (text: string) => moderation(text === 'bad' ? 0.7 : 0.3));
	mocks.serializeScores.mockImplementation((scores: Record<string, number>) => {
		if (scores.harassment === 0.7) throw new Error('scores failed to serialize');
		return '{}';
	});

	await expect(runChannel('channel')).rejects.toThrow('moderation decision failed for 1 comment(s)');

	expect(mocks.state.insertedComments).toEqual([
		expect.objectContaining({ id: 'good', status: 'approved' })
	]);
	expect(mocks.state.channelUpdates).toEqual([]);
});

test('persists the next page token when the scan is incomplete', async () => {
	mocks.scoreComment.mockResolvedValue(moderation(0.34));
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment()],
		nextPageToken: 'next-page',
		reachedCursor: false
	});

	await runChannel('channel');

	expect(mocks.state.channelUpdates).toContainEqual(
		expect.objectContaining({ nextPageToken: 'next-page' })
	);
});

test('keeps the existing cursor when the fetched page is empty', async () => {
	mocks.state.channel = { ...mocks.state.channel, cursor: '2026-01-01T00:00:00.000Z' };
	mocks.fetchNewComments.mockResolvedValue({
		comments: [],
		nextPageToken: null,
		reachedCursor: true
	});

	const result = await runChannel('channel');

	expect(mocks.state.channelUpdates).toContainEqual(
		expect.objectContaining({ cursor: '2026-01-01T00:00:00.000Z' })
	);
	expect(result).toMatchObject({ fetched: 0, skipped: false });
});

test('completes the scan when the cursor is reached even if a page token remains', async () => {
	mocks.scoreComment.mockResolvedValue(moderation(0.34));
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment()],
		nextPageToken: 'next-page',
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.state.channelUpdates).toContainEqual(
		expect.objectContaining({ cursor: '2026-01-04T00:00:00.000Z', nextPageToken: null, scanCursor: null })
	);
});
