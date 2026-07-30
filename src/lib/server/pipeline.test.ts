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
		channel: null as unknown,
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
						claimed.forEach((item) => Object.assign(item, values));
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
		getCommentModerationStatus: vi.fn(),
		setModerationStatus: vi.fn(),
		deleteComment: vi.fn(),
		scoreComment: vi.fn(),
		serializeScores: vi.fn(),
		DeadlineExceededError: class DeadlineExceededError extends Error {}
	};
});

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
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: mocks.refreshAccessToken,
	fetchNewComments: mocks.fetchNewComments,
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
	process.env.DRY_RUN = 'false';
});

afterEach(() => {
	if (originalDryRun === undefined) delete process.env.DRY_RUN;
	else process.env.DRY_RUN = originalDryRun;
});

test.each([
	{ score: 0.34, status: 'approved', queued: 0, acted: 0, api: 'none', audit: 'approve' },
	{ score: 0.35, status: 'pending', queued: 1, acted: 0, api: 'none', audit: 'queue' },
	{ score: 0.5, status: 'pending', queued: 1, acted: 0, api: 'none', audit: 'queue' },
	{ score: 0.51, status: 'deleted', queued: 0, acted: 1, api: 'delete', audit: 'delete' },
	{ score: 0.85, status: 'deleted', queued: 0, acted: 1, api: 'delete', audit: 'delete' },
	{ score: 0.86, status: 'rejected', queued: 0, acted: 1, api: 'ban', audit: 'ban' }
])('categorizes score $score as $status', async ({ score, status, queued, acted, api, audit }) => {
	mocks.scoreComment.mockResolvedValue(moderation(score));

	const result = await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status })]);
	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({ commentId: 'comment', action: audit })]);
	if (api === 'delete') {
		expect(mocks.deleteComment).toHaveBeenCalledWith('comment', 'access-token', undefined);
		expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	} else if (api === 'ban') {
		expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', true, 'access-token', undefined);
		expect(mocks.deleteComment).not.toHaveBeenCalled();
	} else {
		expect(mocks.setModerationStatus).not.toHaveBeenCalled();
		expect(mocks.deleteComment).not.toHaveBeenCalled();
	}
	expect(result).toMatchObject({ fetched: 1, acted, queued, partial: false, skipped: false, dryRun: false });
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

test('persists successful decisions and retries only the failed comment on the next run', async () => {
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ id: 'good', text: 'good' }), newComment({ id: 'bad', text: 'bad' })],
		nextPageToken: 'next-page',
		reachedCursor: false
	});
	mocks.scoreComment.mockImplementation(async (text: string) => {
		if (text === 'bad') throw new Error('OpenAI overloaded');
		return moderation(0.34);
	});

	await expect(runChannel('channel')).rejects.toThrow(
		'moderation decision failed for 1 comment(s): comment bad: OpenAI overloaded'
	);

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'good', status: 'approved' })]);
	expect(mocks.db.update).not.toHaveBeenCalled();

	mocks.scoreComment.mockResolvedValue(moderation(0.34));
	const result = await runChannel('channel');

	expect(mocks.scoreComment).toHaveBeenCalledTimes(3);
	expect(mocks.scoreComment).toHaveBeenLastCalledWith('bad', undefined);
	expect(mocks.state.insertedComments).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: 'good', status: 'approved' }),
		expect.objectContaining({ id: 'bad', status: 'approved' })
	]));
	expect(result).toMatchObject({ fetched: 2, partial: false, skipped: false, dryRun: false });
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
	{ raw: 0.506, status: 'deleted', reason: 'ai score 0.51' },
	{ raw: 0.504, status: 'pending', reason: 'ai score 0.50' }
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
