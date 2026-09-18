import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { auditLog, channelAllowedHandles, channels, comments, creditTransactions, moderationActions, organizations, rules } from '$lib/server/db/schema';
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

	expectNoYoutubeWrites();
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
	{ raw: 0.506, status: 'pending', actions: ['queue', 'hold'], reason: 'ai score 0.51' },
	{ raw: 0.504, status: 'approved', actions: ['approve'], reason: 'ai score 0.50' }
])('rounds the AI score to 2 decimals before deciding ($raw → $status)', async ({ raw, status, actions, reason }) => {
	mocks.scoreComment.mockResolvedValue(moderation(raw));

	await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status })]);
	expect(mocks.state.insertedAudits).toEqual(actions.map((action) => expect.objectContaining({ commentId: 'comment', action, reason })));
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

test('returns a partial result when the deadline hits during dispatched-action verification', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction()];
	mocks.getCommentModerationStatus.mockRejectedValue(new mocks.DeadlineExceededError('out of time'));

	const result = await runChannel('channel');

	expect(result).toEqual({ fetched: 1, acted: 0, queued: 0, partial: true, skipped: false, dryRun: false });
	expectActionState('dispatched');
});

test.each([
	{ action: 'delete', observed: null, completed: true },
	{ action: 'delete', observed: 'rejected', completed: false },
	{ action: 'hold', observed: 'heldForReview', completed: true },
	{ action: 'hold', observed: 'published', completed: false },
	// A remotely-deleted comment needs no moderation: complete the action
	// instead of re-throwing setModerationStatus's 404 every run forever.
	{ action: 'hold', observed: null, completed: true },
	{ action: 'reject', observed: 'rejected', completed: true },
	{ action: 'reject', observed: null, completed: true },
	{ action: 'ban', observed: 'rejected', completed: true },
	{ action: 'ban', observed: null, completed: true },
	{ action: 'ban', observed: 'published', completed: false }
])('verifies a dispatched $action action (observed: $observed, completed: $completed)', async ({ action, observed, completed }) => {
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction({ action })];
	mocks.getCommentModerationStatus.mockResolvedValue(observed);

	await runChannel('channel');

	if (completed) {
		// Terminal on YouTube already: no re-enforcement, just completion.
		expect(mocks.setModerationStatus).not.toHaveBeenCalled();
		expect(mocks.deleteComment).not.toHaveBeenCalled();
	} else if (action === 'delete') {
		expect(mocks.deleteComment).toHaveBeenCalledWith('comment', 'access-token', undefined);
	} else {
		expect(mocks.setModerationStatus).toHaveBeenCalledWith(
			['comment'],
			action === 'hold' ? 'heldForReview' : 'rejected',
			action === 'ban',
			'access-token',
			undefined
		);
	}
	expectActionState('completed');
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
	mocks.getCommentModerationStatus.mockResolvedValue('rejected');

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
	mocks.getCommentModerationStatus.mockResolvedValue('published');

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
	mocks.getCommentModerationStatus.mockResolvedValue('published');
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
	mocks.getCommentModerationStatus.mockResolvedValue('published');
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
	// Preflight 'published' → reject → post-write verify reads 'rejected'.
	mocks.getCommentModerationStatus
		.mockResolvedValueOnce('published')
		.mockResolvedValue('rejected');

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
	// Preflight 'heldForReview' → publish → post-write verify reads 'published'.
	mocks.getCommentModerationStatus
		.mockResolvedValueOnce('heldForReview')
		.mockResolvedValue('published');

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'published', false, 'access-token', undefined);
	expect(mocks.state.insertedComments[0].status).toBe('approved');
});

test('a crashed intent on a remotely-deleted comment finalizes without a remote write', async () => {
	mocks.state.insertedComments = [
		{ id: 'comment', channelId: 'channel', text: 'x', publishedAt: '2026-01-01T00:00:00Z', status: 'restoring', decidedBy: 'human' }
	];
	mocks.fetchNewComments.mockResolvedValue({ comments: [], nextPageToken: null, reachedCursor: true });
	mocks.state.insertedAudits = [
		{ channelId: 'channel', commentId: 'comment', action: 'reject', reason: 'manual review', actor: 'user', createdAt: '2026-01-01T00:00:00Z' }
	];
	mocks.getCommentModerationStatus.mockResolvedValue(null);

	await runChannel('channel');

	expectNoYoutubeWrites();
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

	expect(mocks.getCommentModerationStatus).not.toHaveBeenCalled();
	expect(mocks.state.insertedComments[0].status).toBe('restoring');
});
