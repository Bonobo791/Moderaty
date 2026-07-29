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
			auditLog: undefined as unknown
		},
		channel: null as unknown,
		existingIds: [] as string[],
		ruleRows: [] as unknown[],
		insertedComments: [] as Record<string, unknown>[],
		insertedAudits: [] as Record<string, unknown>[]
	};
	const store = (table: unknown, values: unknown) => {
		const rows = (Array.isArray(values) ? values : [values]) as Record<string, unknown>[];
		if (table === state.tables.comments) state.insertedComments.push(...rows);
		if (table === state.tables.auditLog) state.insertedAudits.push(...rows);
	};
	const query = (table: unknown) => ({
		where: () => ({
			get: async () => {
				if (table === state.tables.channels) return state.channel;
				throw new Error('unexpected get query');
			},
			all: async () => {
				if (table === state.tables.comments) return state.existingIds.map((id) => ({ id }));
				if (table === state.tables.rules) return state.ruleRows;
				throw new Error('unexpected all query');
			}
		})
	});
	const transaction = {
		insert: (table: unknown) => ({ values: async (values: unknown) => store(table, values) }),
		update: () => ({ set: () => ({ where: async () => undefined }) })
	};

	return {
		state,
		db: {
			select: vi.fn(() => ({ from: (table: unknown) => query(table) })),
			insert: vi.fn((table: unknown) => ({ values: async (values: unknown) => store(table, values) })),
			transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction))
		},
		decrypt: vi.fn(),
		assertBeforeDeadline: vi.fn(),
		refreshAccessToken: vi.fn(),
		fetchNewComments: vi.fn(),
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
	setModerationStatus: mocks.setModerationStatus,
	deleteComment: mocks.deleteComment
}));

import { auditLog, channels, comments, rules } from '$lib/server/db/schema';
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

beforeEach(() => {
	vi.clearAllMocks();
	mocks.state.tables = { channels, comments, rules, auditLog };
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
	mocks.state.existingIds = [];
	mocks.state.ruleRows = [];
	mocks.state.insertedComments = [];
	mocks.state.insertedAudits = [];
	mocks.decrypt.mockReturnValue('refresh-token');
	mocks.refreshAccessToken.mockResolvedValue('access-token');
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment()],
		nextPageToken: null,
		reachedCursor: true
	});
	mocks.setModerationStatus.mockResolvedValue(undefined);
	mocks.deleteComment.mockResolvedValue(undefined);
	mocks.serializeScores.mockReturnValue('{}');
	process.env.DRY_RUN = 'false';
});

afterEach(() => {
	if (originalDryRun === undefined) delete process.env.DRY_RUN;
	else process.env.DRY_RUN = originalDryRun;
});

test.each([
	{ score: 0.34, status: 'approved', queued: 0, acted: 0 },
	{ score: 0.35, status: 'pending', queued: 1, acted: 0 },
	{ score: 0.85, status: 'rejected', queued: 0, acted: 1 }
])('categorizes score $score as $status', async ({ score, status, queued, acted }) => {
	mocks.scoreComment.mockResolvedValue(moderation(score));

	const result = await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status })]);
	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(acted);
	expect(result).toMatchObject({ fetched: 1, acted, queued, partial: false, skipped: false, dryRun: false });
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

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'held', status: 'held' })]);
	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({ commentId: 'held', action: 'hold' })]);
});
