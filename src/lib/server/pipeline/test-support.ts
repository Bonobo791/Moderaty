// Shared test harness for the pipeline module suites.
import { expect, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const state = {
		env: { DRY_RUN: 'false' } as Record<string, string | undefined>,
		tables: {
			channels: undefined as unknown,
			comments: undefined as unknown,
			rules: undefined as unknown,
			channelAllowedHandles: undefined as unknown,
			auditLog: undefined as unknown,
			moderationActions: undefined as unknown,
			organizations: undefined as unknown,
			creditTransactions: undefined as unknown
		},
		// Org credit balance the fake organizations select reports (ledger gate).
		credits: 5 as number | null,
		// When true, the fake organizations UPDATE rejects every charge (simulates
		// the balance being exhausted CONCURRENTLY by another run — the in-memory
		// AI budget read N, but by charge time the atomic guard finds 0).
		failCharges: false,
		// Org billing fields the fake organizations select reports.
		plan: 'free' as string,
		stripeSubscriptionId: null as string | null,
		// Stripe customer alone must not enable metering.
		customerId: null as string | null,
		insertedCredits: [] as Record<string, unknown>[],
		channel: {} as Record<string, unknown>,
		channelUpdates: [] as Record<string, unknown>[],
		existingIds: [] as string[],
		unclaimedIds: [] as string[],
		ruleRows: [] as unknown[],
		handleRows: [] as Record<string, unknown>[],
		insertedComments: [] as Record<string, unknown>[],
		insertedAudits: [] as Record<string, unknown>[],
		moderationActions: [] as Record<string, unknown>[]
	};
	const store = (table: unknown, values: unknown) => {
		const rows = (Array.isArray(values) ? values : [values]) as Record<string, unknown>[];
		if (table === state.tables.comments) state.insertedComments.push(...rows);
		if (table === state.tables.auditLog) state.insertedAudits.push(...rows);
		if (table === state.tables.moderationActions) state.moderationActions.push(...rows);
		if (table === state.tables.creditTransactions) state.insertedCredits.push(...rows);
	};
	const query = (table: unknown) => ({
		where: (condition?: unknown) => ({
			get: async () => {
				if (table === state.tables.channels) {
					const params = queryParams(condition);
					const channelId = state.channel && typeof state.channel.id === 'string' ? state.channel.id : null;
					return channelId && (!params.length || params.includes(channelId)) ? state.channel : undefined;
				}
				// Ledger balance + metering lookup (consumeCredit's org existence
				// check and the orgIsMetered gate).
				if (table === state.tables.organizations) {
					return { creditsRemaining: state.credits, plan: state.plan, stripeSubscriptionId: state.stripeSubscriptionId, stripeCustomerId: state.customerId };
				}
				throw new Error('unexpected get query');
			},
			all: async () => {
				if (table === state.tables.comments) {
					// Honor the inArray(comments.id, ...) condition: a row only counts as
					// already-stored when the query actually selects its id.
					const params = queryParams(condition);
					return [...new Set([
						...state.existingIds,
						...state.insertedComments.map((comment) => queryKey(comment.id))
					])].filter((id) => params.includes(id)).map((id) => ({ id }));
				}
				if (table === state.tables.rules) {
					const params = queryParams(condition);
					return state.ruleRows.filter((row) => {
						if (!row || typeof row !== 'object' || !('channelId' in row)) {
							throw new Error('rule mock row is missing channelId');
						}
						return params.includes(queryKey((row as { channelId: unknown }).channelId));
					});
				}
				if (table === state.tables.channelAllowedHandles) {
					// Honor eq(channelId, ...): only rows for the queried channel come back.
					const params = queryParams(condition);
					return state.handleRows.filter((row) => params.includes(queryKey(row.channelId)));
				}
				if (table === state.tables.moderationActions) {
					// Honor eq(channelId, ...) + inArray(state, [...]): only rows whose
					// channel and state the query actually selects come back.
					const params = queryParams(condition);
					return state.moderationActions.filter((action) =>
						params.includes(queryKey(action.channelId)) && params.includes(queryKey(action.state)));
				}
				throw new Error('unexpected all query');
			}
		})
	});
	const transaction = {
		insert: vi.fn((table: unknown) => ({
			values: (values: unknown) => {
				// Real drizzle values() is SYNC and returns the query builder — the
				// chain must be returned synchronously or onConflictDoNothing lands
				// on a Promise.
				store(table, values);
				// Ledger inserts chain onConflictDoNothing().returning() — simulate a
				// fresh insert (never a conflict) so consumeCredit sees a charge.
				return { onConflictDoNothing: () => ({ returning: async () => [{ id: 1 }] }) };
			}
		})),
		select: vi.fn(() => ({ from: (table: unknown) => query(table) })),
		delete: vi.fn((table: unknown) => ({
			where: async () => {
				if (table === state.tables.creditTransactions) {
					// consumeCredit deletes its just-inserted row when the balance
					// guard rejects the charge — mirror that by un-recording it.
					state.insertedCredits.pop();
					return undefined;
				}
				throw new Error('unexpected delete query');
			}
		})),
		update: vi.fn((table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: (condition?: unknown) => {
					const none = { returning: async () => [] as Record<string, unknown>[] };
					if (table === state.tables.organizations) {
						// Ledger balance decrement simulates the real guard: at balance 0
						// the UPDATE matches nothing (comment stages free — consumeCredit
						// deletes its row and returns false); otherwise one credit lower.
						// failCharges forces the same rejection regardless of the balance:
						// another run exhausted the credits between the budget read and
						// the atomic charge.
						if (state.failCharges || (state.credits ?? 0) <= 0) return { returning: async () => [] as Record<string, unknown>[] };
						state.credits = Math.max(0, (state.credits ?? 0) - 1);
						return { returning: async () => [{ creditsRemaining: state.credits }] };
					}
					if (table === state.tables.channels) {
						// The active=active no-op is the atomic channel guard. It must
						// return no row for a deleted/inactive channel and must not be
						// confused with a cursor update in assertions.
						if ('active' in values) {
							const params = queryParams(condition);
							const identityMatches = params.length <= 2 || params.includes(state.channel?.refreshTokenEnc);
							return { returning: async () => state.channel?.active && identityMatches ? [{ id: state.channel.id }] : [] };
						}
						state.channelUpdates.push(values);
						return none;
					}
					if (table !== state.tables.moderationActions || !('state' in values)) return none;
					if (values.state === 'dispatched' && !('lastAttemptAt' in values)) {
						// Atomic claim: only pending rows transition, and the claimed ids
						// come back via RETURNING. Ids in unclaimedIds simulate a
						// concurrent run that claimed the row first. The where-clause is
						// honored: ids the query does not select are never claimed, and
						// without eq(state, 'pending') no row transitions at all.
						const params = queryParams(condition);
						if (!params.includes('pending')) return { returning: async () => [] as Record<string, unknown>[] };
						const claimed = state.moderationActions.filter((item) =>
							item.state === 'pending' &&
							params.includes(queryKey(item.commentId)) &&
							!state.unclaimedIds.includes(queryKey(item.commentId)));
						claimed.forEach((item) => {
							Object.assign(item, values);
						});
						const claimedCommentIds = claimed.map((item) => ({ commentId: item.commentId }));
						const returningClaimedIds = async (fields: unknown) =>
							fields && typeof fields === 'object' && 'commentId' in fields ? claimedCommentIds : [];
						return { returning: returningClaimedIds };
					}
					// markDispatched / completeActions: honor inArray(commentId, ...) —
					// only rows whose id the query selects are updated.
					const params = queryParams(condition);
					state.moderationActions.forEach((item) => {
						if (params.includes(queryKey(item.commentId))) Object.assign(item, values);
					});
					return none;
				}
			})
		}))
	};

	const runTransaction = async (callback: (value: typeof transaction) => Promise<unknown>) => {
		const snapshot = {
			credits: state.credits,
			channel: state.channel ? { ...state.channel } : state.channel,
			channelUpdates: [...state.channelUpdates],
			insertedCredits: [...state.insertedCredits],
			insertedComments: [...state.insertedComments],
			insertedAudits: [...state.insertedAudits],
			moderationActions: state.moderationActions.map((row) => ({ ...row }))
		};
		try {
			return await callback(transaction);
		} catch (error) {
			state.credits = snapshot.credits;
			state.channel = snapshot.channel;
			state.channelUpdates = snapshot.channelUpdates;
			state.insertedCredits = snapshot.insertedCredits;
			state.insertedComments = snapshot.insertedComments;
			state.insertedAudits = snapshot.insertedAudits;
			state.moderationActions = snapshot.moderationActions;
			throw error;
		}
	};

	return {
		state,
		db: {
			select: vi.fn(() => ({ from: (table: unknown) => query(table) })),
			insert: vi.fn((table: unknown) => ({ values: async (values: unknown) => store(table, values) })),
			transaction: vi.fn(runTransaction),
			update: vi.fn((table: unknown) => transaction.update(table)),
			transactionValue: transaction
		},
		defaultTransaction: runTransaction,
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
		resolveOpenAiKey: vi.fn(),
		checkSync: vi.fn(() => ({ status: 'safe' })),
		DeadlineExceededError: class DeadlineExceededError extends Error {}
	};
});

export function getMocks() { return mocks; }

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
vi.mock('$lib/server/openaiKey', () => ({
	resolveOpenAiKey: mocks.resolveOpenAiKey
}));
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: mocks.refreshAccessToken,
	fetchNewComments: mocks.fetchNewComments,
	fetchVideoMetadata: mocks.fetchVideoMetadata,
	getCommentModerationStatus: mocks.getCommentModerationStatus,
	setModerationStatus: mocks.setModerationStatus,
	deleteComment: mocks.deleteComment
}));

import { auditLog, channelAllowedHandles, channels, comments, creditTransactions, moderationActions, organizations, rules } from '$lib/server/db/schema';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { NewComment } from '../youtube';

const dialect = new SQLiteSyncDialect();

/** Binds the parameters of a real drizzle where-condition so the fake store
 * honors which rows a query actually targets. */
function queryParams(condition: unknown): unknown[] {
	if (!condition) return [];
	return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]).params;
}

function queryKey(value: unknown): string {
	if (typeof value !== 'string') throw new Error('mock query key must be a string');
	return value;
}

const originalDryRun = process.env.DRY_RUN;

export function newComment(overrides: Partial<NewComment> = {}): NewComment {
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

export function moderation(score: number) {
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

export function dispatchedAction(overrides: Record<string, unknown> = {}) {
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


/** One dry-run window page over a single fetched comment (live env). */
export function runWindowPage({
	pageToken = null,
	nextPageToken = null,
	reachedCursor = true
}: { pageToken?: string | null; nextPageToken?: string | null; reachedCursor?: boolean } = {}) {
	mocks.state.env.DRY_RUN = 'false';
	mocks.scoreComment.mockResolvedValue(moderation(0.34));
	mocks.fetchNewComments.mockResolvedValue({ comments: [newComment()], nextPageToken, reachedCursor });
	return runChannel('channel', { forceDryRun: true, window: { boundary: '2026-05-01T00:00:00.000Z', pageToken } });
}

export function protectHandle(handle: string) {
	mocks.state.handleRows = [{ id: 1, channelId: 'channel', handle, createdAt: '2026-01-01T00:00:00.000Z' }];
}

export function expectActionState(state: string) {
	expect(mocks.state.moderationActions).toEqual([expect.objectContaining({ commentId: 'comment', state })]);
}

export function expectAiUnavailableQueued(result: unknown, extra: Record<string, unknown> = {}) {
	expect(mocks.state.insertedComments).toEqual([
		expect.objectContaining({ id: 'comment', status: 'pending', decidedBy: 'none', aiScore: null })
	]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'queue', reason: expect.stringContaining('ai unavailable') })
	]);
	expect(result).toMatchObject({ acted: 0, queued: 1, ...extra });
}

export function resetPipelineMocks() {
	vi.clearAllMocks();
	mocks.db.transaction.mockReset();
	mocks.db.transaction.mockImplementation(mocks.defaultTransaction);
	// clearAllMocks preserves implementations. Reset every external behavior
	// mock explicitly so one test cannot leak a rejection or custom handler into
	// the next test.
	for (const mock of [
		mocks.decrypt,
		mocks.assertBeforeDeadline,
		mocks.refreshAccessToken,
		mocks.fetchNewComments,
		mocks.fetchVideoMetadata,
		mocks.getCommentModerationStatus,
		mocks.setModerationStatus,
		mocks.deleteComment,
		mocks.scoreComment,
		mocks.serializeScores,
		mocks.scoreTone,
		mocks.resolveOpenAiKey
	]) mock.mockReset();
	mocks.state.tables = { channels, comments, rules, channelAllowedHandles, auditLog, moderationActions, organizations, creditTransactions };
	mocks.state.credits = 5;
	mocks.state.failCharges = false;
	mocks.state.plan = 'free';
	mocks.state.stripeSubscriptionId = null;
	mocks.state.customerId = null;
	mocks.state.insertedCredits = [];
	mocks.state.env.DRY_RUN = 'false';
	mocks.state.channel = {
		id: 'channel',
		userId: 'user',
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
	mocks.state.handleRows = [];
	mocks.state.insertedComments = [];
	mocks.state.insertedAudits = [];
	mocks.state.moderationActions = [];
	mocks.decrypt.mockReturnValue('refresh-token');
	mocks.assertBeforeDeadline.mockImplementation(() => undefined);
	mocks.refreshAccessToken.mockResolvedValue('access-token');
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment()],
		nextPageToken: null,
		reachedCursor: true
	});
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.setModerationStatus.mockResolvedValue(undefined);
	mocks.deleteComment.mockResolvedValue(undefined);
	mocks.getCommentModerationStatus.mockResolvedValue('rejected');
	mocks.serializeScores.mockReturnValue('{}');
	mocks.scoreTone.mockResolvedValue({ score: 0 });
	mocks.resolveOpenAiKey.mockResolvedValue('sk-resolved-key');
	mocks.fetchVideoMetadata.mockResolvedValue(new Map([
		['video', { title: 'Video title', description: 'Video description' }]
	]));
	process.env.DRY_RUN = 'false';
}

export function restoreDryRun() {
	if (originalDryRun === undefined) delete process.env.DRY_RUN;
	else process.env.DRY_RUN = originalDryRun;
}


export async function runChannel(channelId: string, options?: import('./types').RunChannelOptions) {
	return (await import('./run')).runChannel(channelId, options);
}
