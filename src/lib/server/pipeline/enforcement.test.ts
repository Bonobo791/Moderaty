import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { auditLog, channelAllowedHandles, channels, comments, creditTransactions, moderationActions, organizations, rules } from '$lib/server/db/schema';
import { CommentNotFoundError } from '../youtube';
import {
	dispatchedAction,
	expectActionState,
	expectAiUnavailableQueued,
	expectHeldForReview,
	expectNoYoutubeWrites,
	getMocks,
	moderation,
	newComment,
	resetPipelineMocks,
	protectHandle,
	runWindowPage,
	restoreDryRun,
	runChannel
} from './test-support';

const mocks = getMocks();

beforeEach(resetPipelineMocks);
afterEach(restoreDryRun);

test('records successful remote actions before a later action fails', async () => {
	mocks.state.ruleRows = [
		{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'hold', action: 'hold' },
		{ id: 2, channelId: 'channel', type: 'keyword', pattern: 'reject', action: 'reject' }
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

test('re-applies a dispatched hold without requesting YouTube moderation status', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction({ action: 'hold' })];
	mocks.state.commentStatuses = { comment: 'pending' };
	mocks.fetchWithRetry.mockRejectedValueOnce(new Error('comments.list response moderationStatus is missing or invalid'));

	await expect(runChannel('channel')).resolves.toMatchObject({ partial: false, dryRun: false });

	expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'heldForReview', false, 'access-token', undefined);
	expectActionState('completed');
	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({ commentId: 'comment', action: 'hold' })]);
});

test('verifies a dispatched action after its completion transaction fails', async () => {
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'reject' }];
	mocks.db.transaction
		.mockImplementationOnce(async (callback: (value: typeof mocks.db.transactionValue) => Promise<unknown>) => callback(mocks.db.transactionValue))
		.mockImplementationOnce(async (callback: (value: typeof mocks.db.transactionValue) => Promise<unknown>) => callback(mocks.db.transactionValue))
		.mockImplementationOnce(async (callback: (value: typeof mocks.db.transactionValue) => Promise<unknown>) => callback(mocks.db.transactionValue))
		.mockRejectedValueOnce(new Error('database write failed'));

	await expect(runChannel('channel')).rejects.toThrow('database write failed');

	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(1);
	expectActionState('dispatched');

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(2);
	expectActionState('completed');
});

test.each([
	{ action: 'reject', status: 'rejected', banAuthor: false },
	{ action: 'ban', status: 'rejected', banAuthor: true },
	{ action: 'delete', status: null, banAuthor: false }
] as const)('re-applies a dispatched $action action', async ({ action, status, banAuthor }) => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction({ action })];

	await runChannel('channel');

	if (action === 'delete') {
		expect(mocks.deleteComment).toHaveBeenCalledWith('comment', 'access-token', undefined);
		expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	} else {
		expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], status, banAuthor, 'access-token', undefined);
		expect(mocks.deleteComment).not.toHaveBeenCalled();
	}
	expectActionState('completed');
	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({ commentId: 'comment', action })]);
});

test.each([
	{ raw: 0.506, status: 'pending', actions: ['queue', 'hold'], reason: 'ai score 0.51' },
	{ raw: 0.504, status: 'approved', actions: ['approve'], reason: 'ai score 0.50' }
])('rounds the AI score to 2 decimals before deciding ($raw → $status)', async ({ raw, status, actions, reason }) => {
	mocks.scoreComment.mockResolvedValue(moderation(raw));

	await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status })]);
	expect(mocks.state.insertedAudits).toEqual(actions.map((action) => expect.objectContaining({ commentId: 'comment', action, reason })));
});

test('a cancelling action is superseded without a YouTube call and warns the owner', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction({ action: 'reject', state: 'cancelling' })];
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

	await runChannel('channel');

	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expectActionState('superseded');
	expect(mocks.state.insertedAudits).toEqual([]);
	expect(warning).toHaveBeenCalledWith(
		'moderation action comment (reject) was cancelled by a rescan after dispatch — YouTube may still reflect it; left unchanged until the user acts'
	);
});

test('a 404 moderation batch retries each hold and completes a comment still missing individually', async () => {
	const ids = ['a', 'b', 'c'];
	mocks.state.existingIds = ids;
	mocks.fetchNewComments.mockResolvedValue({ comments: [], nextPageToken: null, reachedCursor: true });
	mocks.state.commentStatuses = Object.fromEntries(ids.map((id) => [id, 'pending']));
	mocks.state.moderationActions = ids.map((commentId) => dispatchedAction({ commentId, action: 'hold' }));
	mocks.setModerationStatus
		.mockRejectedValueOnce(new CommentNotFoundError(ids))
		.mockResolvedValueOnce(undefined)
		.mockResolvedValueOnce(undefined)
		.mockRejectedValueOnce(new CommentNotFoundError(['c']));
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const result = await runChannel('channel');

	expect(result.acted).toBe(2);
	expect(mocks.setModerationStatus.mock.calls.map(([batch]) => batch)).toEqual([ids, ['a'], ['b'], ['c']]);
	expect(mocks.state.moderationActions).toEqual(ids.map((commentId) => expect.objectContaining({ commentId, state: 'completed' })));
	expect(mocks.state.insertedAudits).toHaveLength(3);
	expect(warning).toHaveBeenCalledWith('comment c no longer exists on YouTube — completing hold');
});

test('a non-404 moderation failure leaves dispatched actions retryable', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction({ action: 'reject' })];
	mocks.setModerationStatus.mockRejectedValueOnce(new Error('socket hang up'));

	await expect(runChannel('channel')).rejects.toThrow('socket hang up');

	expectActionState('dispatched');
	expect(mocks.state.insertedAudits).toEqual([]);
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
	expectNoYoutubeWrites();
	expect(mocks.state.channelUpdates).toEqual([]);
	expect(result).toMatchObject({ fetched: 1, partial: true, dryRun: false });
});

test('stops when account deletion replaces the shared-channel connector identity', async () => {
	mocks.scoreComment.mockImplementation(async () => {
		mocks.state.channel = { ...mocks.state.channel, userId: null, refreshTokenEnc: 'erased:account-deletion' };
		return moderation(0.95);
	});

	const result = await runChannel('channel');

	expect(result).toMatchObject({ partial: true, skipped: false });
	expect(mocks.state.insertedComments).toEqual([]);
	expectNoYoutubeWrites();
});

test('does not dispatch staged enforcement when the channel is deactivated after decisions are staged', async () => {
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'reject' }];
	// Deletion commits during the staging transaction: the staged rows belong to
	// the pre-delete run, but no YouTube enforcement may follow.
	mocks.db.transaction.mockImplementationOnce(async (callback: (value: typeof mocks.db.transactionValue) => Promise<unknown>) => {
		mocks.state.channel = { ...mocks.state.channel, active: 0 };
		return callback(mocks.db.transactionValue);
	});

	const result = await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([]);
	expect(mocks.state.insertedAudits).toEqual([]);
	expect(mocks.state.moderationActions).toEqual([]);
	expectNoYoutubeWrites();
	expect(mocks.state.channelUpdates).toEqual([]);
	expect(result).toMatchObject({ partial: true });
});

test('skips a pending action already claimed by a concurrent run', async () => {
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'reject' }];
	mocks.state.unclaimedIds = ['comment'];

	const result = await runChannel('channel');

	expectNoYoutubeWrites();
	expect(mocks.state.insertedAudits).toEqual([]);
	expectActionState('pending');
	expect(result).toMatchObject({ fetched: 1, acted: 0, skipped: false, dryRun: false });
});

test('rule delete action enforces deleteComment end-to-end', async () => {
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'delete' }];

	const result = await runChannel('channel');

	expect(mocks.state.moderationActions).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'delete', state: 'completed' })
	]);
	// markDispatched stamps the attempt before the YouTube call (I3).
	expect(mocks.state.moderationActions[0].lastAttemptAt).toEqual(expect.any(String));
	expect(mocks.deleteComment).toHaveBeenCalledWith('comment', 'access-token', undefined);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(result).toMatchObject({ fetched: 1, acted: 1, dryRun: false });
});

test('rule ban action rejects the comment with banAuthor set', async () => {
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'ban' }];

	const result = await runChannel('channel');

	expect(mocks.state.moderationActions).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'ban', state: 'completed' })
	]);
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', true, 'access-token', undefined);
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect(result).toMatchObject({ fetched: 1, acted: 1, dryRun: false });
});

test('rule hold action dispatches heldForReview to YouTube', async () => {
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'hold' }];

	const result = await runChannel('channel');

	expectHeldForReview();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect(result).toMatchObject({ fetched: 1, acted: 1, dryRun: false });
});

test('returns a partial result when the deadline hits during a dispatched action', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction()];
	mocks.setModerationStatus.mockRejectedValue(new mocks.DeadlineExceededError('out of time'));

	const result = await runChannel('channel');

	expect(result).toEqual({ fetched: 1, acted: 0, queued: 0, partial: true, skipped: false, dryRun: false, stoppedReason: 'deadline' });
	expectActionState('dispatched');
});

test('fails loudly on an unknown stored moderation action', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction({ action: 'explode' })];

	await expect(runChannel('channel')).rejects.toThrow('moderation action is invalid: explode');

	expectNoYoutubeWrites();
});

test('does not run the claim update when there is nothing pending to claim', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction()];

	await runChannel('channel');

	expectActionState('completed');
	// The empty claim short-circuits; the run still persists its cursor.
	expect(mocks.state.channelUpdates).toContainEqual(expect.objectContaining({ cursor: expect.anything() }));
});

test('applies YouTube moderation in batches of 50', async () => {
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'spam', action: 'reject' }];
	mocks.fetchNewComments.mockResolvedValue({
		comments: Array.from({ length: 51 }, (_, index) => newComment({ id: `c${index}`, text: `spam ${index}` })),
		nextPageToken: null,
		reachedCursor: true
	});

	const result = await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(2);
	expect(mocks.setModerationStatus.mock.calls[0][0]).toHaveLength(50);
	expect(mocks.setModerationStatus.mock.calls[1][0]).toHaveLength(1);
	expect(result).toMatchObject({ fetched: 51, acted: 51, dryRun: false });
});

test('fails the run with every per-comment failure joined, each naming its comment', async () => {
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ id: 'bad1', text: 'bad one' }), newComment({ id: 'bad2', text: 'bad two' })],
		nextPageToken: null,
		reachedCursor: true
	});
	mocks.scoreComment.mockResolvedValue(moderation(0.7));
	mocks.serializeScores.mockImplementation(() => {
		throw new Error('scores failed to serialize');
	});

	await expect(runChannel('channel')).rejects.toThrow(
		'moderation decision failed for 2 comment(s): comment bad1: scores failed to serialize; comment bad2: scores failed to serialize'
	);
});

test('a dry run never issues a YouTube write for a queued comment (I8)', async () => {
	mocks.state.env.DRY_RUN = 'true';
	mocks.scoreComment.mockResolvedValue(moderation(0.6));

	const result = await runChannel('channel');

	expect(result).toMatchObject({ fetched: 1, queued: 1, dryRun: true });
	expectNoYoutubeWrites();
	expect(mocks.state.insertedComments).toEqual([]);
	expect(mocks.state.moderationActions).toEqual([]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'dry-run' })
	]);
});

test('a completed queue hold is never re-issued — reruns are idempotent (I4)', async () => {
	mocks.scoreComment.mockResolvedValue(moderation(0.6));

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(1);

	// The second run dedupes the stored comment and never reselects the
	// completed hold — no second YouTube write.
	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(1);
	expectActionState('completed');
});

test.each([
	{ state: 'pending' },
	{ state: 'dispatched' }
])('a human decision supersedes an unapplied queue hold ($state) — it is never held', async ({ state }) => {
	// The review queue claimed the comment while its staged 'hold' was still
	// outstanding: the hold must not be applied after the fact.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'approved' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'hold', reason: 'ai score 0.60', state })];

	const result = await runChannel('channel');

	expectNoYoutubeWrites();
	expectActionState('superseded');
	// A never-applied hold writes no completion audit row.
	expect(mocks.state.insertedAudits).toEqual([]);
	expect(result).toMatchObject({ acted: 0 });
});

test('a hold is not superseded when the comment returned to pending before the supersede commit', async () => {
	// partitionHolds read 'approved' and queued the row for supersede; a failed
	// human action then restored 'pending' before markSuperseded's transaction
	// read — superseding now would strand it (public on YouTube while the
	// queue calls it held, nothing retrying). The in-transaction re-check must
	// leave the hold dispatched.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'approved' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'hold', reason: 'ai score 0.60' })];
	// comments reads: #1 stored-ids dedupe, #2 partitionHolds, #3 the
	// supersede re-check — flip to 'pending' exactly at the re-check.
	mocks.state.onCommentsSelect = (callIndex) => {
		if (callIndex === 3) mocks.state.commentStatuses = { comment: 'pending' };
	};

	await runChannel('channel');

	expectActionState('dispatched');
	expect(mocks.state.insertedAudits).toEqual([]);
});

test('a completed transition never rewrites a concurrently superseded row nor audits it', async () => {
	// The human queue decision superseded the action while our remote call was
	// in flight: completion must skip the row — no terminal-state rewrite, and
	// no audit row for a remote write the record says never landed.
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction({ action: 'reject', reason: 'rule #1 (keyword)' })];
	mocks.setModerationStatus.mockImplementation(async () => {
		mocks.state.moderationActions[0].state = 'superseded';
	});

	await runChannel('channel');

	expect(mocks.state.moderationActions[0].state).toBe('superseded');
	expect(mocks.state.insertedAudits).toEqual([]);
});

test('a crashed human action is re-executed and finalized by the reconcile sweep', async () => {
	// The queue claim left the comment 'restoring' with a durable intent audit
	// (I3) and crashed before finishing: the next run must finish exactly the
	// recorded intent and land the final status — not leave it dangling.
	mocks.state.insertedComments = [
		{ id: 'comment', channelId: 'channel', text: 'x', publishedAt: '2026-01-01T00:00:00Z', status: 'restoring', decidedBy: 'human' }
	];
	mocks.fetchNewComments.mockResolvedValue({ comments: [], nextPageToken: null, reachedCursor: true });
	mocks.state.insertedAudits = [
		{ channelId: 'channel', commentId: 'comment', action: 'reject', reason: 'manual review', actor: 'user', createdAt: '2026-01-01T00:00:00Z' }
	];

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
	expect(mocks.state.insertedComments[0].status).toBe('rejected');
});

test('a crashed approve intent is republished and finalized by the reconcile sweep', async () => {
	mocks.state.insertedComments = [
		{ id: 'comment', channelId: 'channel', text: 'x', publishedAt: '2026-01-01T00:00:00Z', status: 'restoring', decidedBy: 'human' }
	];
	mocks.fetchNewComments.mockResolvedValue({ comments: [], nextPageToken: null, reachedCursor: true });
	mocks.state.insertedAudits = [
		{ channelId: 'channel', commentId: 'comment', action: 'approve', reason: 'manual review', actor: 'user', createdAt: '2026-01-01T00:00:00Z' }
	];

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'published', false, 'access-token', undefined);
	expect(mocks.state.insertedComments[0].status).toBe('approved');
});

test('a missing comment during a crashed intent warns and finalizes', async () => {
	mocks.state.insertedComments = [
		{ id: 'comment', channelId: 'channel', text: 'x', publishedAt: '2026-01-01T00:00:00Z', status: 'restoring', decidedBy: 'human' }
	];
	mocks.fetchNewComments.mockResolvedValue({ comments: [], nextPageToken: null, reachedCursor: true });
	mocks.state.insertedAudits = [
		{ channelId: 'channel', commentId: 'comment', action: 'reject', reason: 'manual review', actor: 'user', createdAt: '2026-01-01T00:00:00Z' }
	];
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
	mocks.setModerationStatus.mockRejectedValueOnce(new CommentNotFoundError(['comment']));

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
	expect(warning).toHaveBeenCalledWith('comment comment no longer exists on YouTube — completing reject');
	expect(mocks.state.insertedComments[0].status).toBe('rejected');
});

test('the reconcile sweep ignores a restoring comment without a user intent audit', async () => {
	// 'restoring' rows a human never claimed (or whose latest audit is a
	// system action) are not ours to finish.
	mocks.state.insertedComments = [
		{ id: 'comment', channelId: 'channel', text: 'x', publishedAt: '2026-01-01T00:00:00Z', status: 'restoring', decidedBy: 'human' }
	];
	mocks.fetchNewComments.mockResolvedValue({ comments: [], nextPageToken: null, reachedCursor: true });
	mocks.state.insertedAudits = [
		{ channelId: 'channel', commentId: 'comment', action: 'reject', reason: 'rule #1 (keyword)', actor: 'system', createdAt: '2026-01-01T00:00:00Z' }
	];

	await runChannel('channel');

	expectNoYoutubeWrites();
	expect(mocks.state.insertedComments[0].status).toBe('restoring');
});
