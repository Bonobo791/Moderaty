import { format } from 'node:util';

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

test('a cancelling action on an undecided comment is superseded without a YouTube call', async () => {
	// The comment is still 'held' locally: remote hidden state already matches
	// intent — no corrective write needed, and every later decision writes
	// its own remote state.
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction({ action: 'reject', state: 'cancelling' })];

	await runChannel('channel');

	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expectActionState('superseded');
	expect(mocks.state.insertedAudits).toEqual([]);
});

test('a cancelling reject re-publishes a rescan-approved comment before superseding', async () => {
	// codex: a dispatched reject can be live on YouTube when the rescan
	// approves the comment — superseding without the corrective write leaves
	// it hidden remotely with nothing reconciling it.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'approved' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'reject', state: 'cancelling' })];

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'published', false, 'access-token', undefined);
	expectActionState('superseded');
});

test('a cancelling hold re-publishes a rescan-approved comment before superseding', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'approved' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'hold', state: 'cancelling' })];

	await runChannel('channel');

	// The dispatched hold may have landed remotely: publish restores the
	// comment the rescan approved, then the row can go terminal.
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'published', false, 'access-token', undefined);
	expectActionState('superseded');
});

test('a missing publish target converges the comment to deleted — never left approved over a remote deletion', async () => {
	// codex: a dispatched delete already landed on YouTube before the rescan
	// approved the comment — the corrective publish 404s because the comment
	// is irreversibly gone. Treating that as convergence superseded the
	// delete's bookkeeping over a local-'approved'/remote-deleted lie nothing
	// could repair. Remote truth wins: the comment converges to 'deleted'.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'approved' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'delete', state: 'cancelling' })];
	mocks.setModerationStatus.mockRejectedValueOnce(new CommentNotFoundError(['comment']));
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'published', false, 'access-token', undefined);
	expect(mocks.state.commentStatuses.comment).toBe('deleted');
	expectActionState('superseded');
	expect(warning).toHaveBeenCalledWith('comment comment no longer exists on YouTube — completing approve');
});

test('a missing publish target leaves a mid-flight human claim owned by its own flow', async () => {
	// The corrective write 404s — but the comment was claimed 'restoring'
	// between the convergence read and the flip: the CAS must NOT overwrite a
	// status it did not read, and the action stays outstanding rather than
	// terminalizing over a decision that is no longer the one checked.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'approved' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'delete', state: 'cancelling' })];
	mocks.setModerationStatus.mockImplementation(async () => {
		mocks.state.commentStatuses.comment = 'restoring';
		throw new CommentNotFoundError(['comment']);
	});
	vi.spyOn(console, 'warn').mockImplementation(() => {});

	await runChannel('channel');

	expect(mocks.state.commentStatuses.comment).toBe('restoring');
	expectActionState('cancelling');
});

test('a failed convergence write keeps a cancelling hold retryable', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'approved' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'hold', state: 'cancelling' })];
	mocks.setModerationStatus.mockRejectedValueOnce(new Error('socket hang up'));
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

	await runChannel('channel');

	expectActionState('cancelling');
	expect(warning).toHaveBeenCalled();

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenLastCalledWith(['comment'], 'published', false, 'access-token', undefined);
	expectActionState('superseded');
});

test('a failed convergence write logs the comment id verbatim — a % in it cannot swallow the error arg', async () => {
	// console.warn treats arg[0] as a util.format format string: an id
	// interpolated INTO it turns `%s` inside the id into a specifier that
	// consumes the trailing error and hides the real failure (codeant).
	mocks.state.existingIds = ['c%s-1'];
	mocks.state.commentStatuses = { 'c%s-1': 'approved' };
	mocks.state.moderationActions = [dispatchedAction({ commentId: 'c%s-1', action: 'hold', state: 'cancelling' })];
	mocks.setModerationStatus.mockRejectedValueOnce(new Error('socket hang up'));
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

	await runChannel('channel');

	expect(mocks.state.moderationActions).toEqual([expect.objectContaining({ commentId: 'c%s-1', state: 'cancelling' })]);
	const call = warning.mock.calls.find((args) => String(args[0]).includes('convergence failed'));
	expect(call).toBeDefined();
	expect(format(...call!)).toContain('c%s-1');
	expect(format(...call!)).toContain('socket hang up');
});

test('a human approval landing while a hold write is in flight is re-applied after the hold lands', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'pending' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'hold' })];
	mocks.setModerationStatus.mockImplementationOnce(async () => {
		// The owner's approve commits while the heldForReview write is in flight.
		mocks.state.commentStatuses.comment = 'approved';
	});

	await runChannel('channel');

	// The corrective publish already re-asserted 'approved'; the hold row
	// itself stays 'cancelling' until a later sweep proves its write can no
	// longer reorder a decided comment's remote state (codex).
	expect(mocks.setModerationStatus.mock.calls).toEqual([
		[['comment'], 'heldForReview', false, 'access-token', undefined],
		[['comment'], 'published', false, 'access-token', undefined]
	]);
	expectActionState('cancelling');

	await runChannel('channel');
	expect(mocks.setModerationStatus).toHaveBeenLastCalledWith(['comment'], 'published', false, 'access-token', undefined);
	expectActionState('superseded');
});

test('a dispatched hold superseded by a decided comment publishes it back instead of stranding it held', async () => {
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'approved' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'hold' })];

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'published', false, 'access-token', undefined);
	expect(mocks.setModerationStatus).not.toHaveBeenCalledWith(['comment'], 'heldForReview', false, 'access-token', undefined);
	expectActionState('superseded');
});

test('a hold on a restoring comment is not converged — the human flow and the next sweep resolve it', async () => {
	// codex: terminalizing the row while 'restoring' would drop the only
	// mechanism that re-writes remote state if the hold landed after the
	// human's write. The intent conflicts with the hold's outcome, so
	// finalize keeps it 'cancelling' — the next sweep's corrective write is
	// guaranteed to land after any in-flight hold.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'restoring' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'hold' })];
	mocks.state.insertedAudits = [
		{ channelId: 'channel', commentId: 'comment', action: 'reject', reason: 'queue UI', actor: 'user', createdAt: '2026-01-04T00:00:01.000Z' }
	];

	await runChannel('channel');

	// The recorded intent replays; the raced hold stays outstanding — its
	// write may land after the human's reject, so 'completed' would lie.
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
	expectActionState('cancelling');
	expect(mocks.state.insertedAudits).not.toContainEqual(expect.objectContaining({ commentId: 'comment', action: 'hold', actor: 'system' }));

	// Next sweep: the corrective reject re-asserts the decided state and the
	// row goes terminal — remote truth converges to 'rejected'.
	await runChannel('channel');
	expect(mocks.setModerationStatus).toHaveBeenLastCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
	expectActionState('superseded');
});

test('a dispatched hold on a restoring comment stays outstanding without a user intent', async () => {
	// No user intent audit → reconcile leaves the comment alone, and the hold
	// row must NOT be falsely converged — it stays dispatched for a later
	// sweep to resolve once the status decides (codex).
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'restoring' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'hold' })];

	await runChannel('channel');

	expectNoYoutubeWrites();
	expectActionState('dispatched');
	expect(mocks.state.insertedAudits).toEqual([]);
});

test('a dispatched reject on a restoring comment stays reconcilable — the corrective write lands last', async () => {
	// codex: the reject's remote write may still be in flight when the
	// owner's publish lands. Completing the row claims an ordering no one
	// can prove — remote would stay 'rejected' over a local 'approved' with
	// nothing reconciling. 'cancelling' keeps it outstanding until the next
	// sweep's corrective publish lands LAST.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'restoring' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'reject' })];
	mocks.state.insertedAudits = [
		{ channelId: 'channel', commentId: 'comment', action: 'restore', reason: 'undo', actor: 'user', createdAt: '2026-01-04T00:00:01.000Z' }
	];

	await runChannel('channel');

	// 'restore' publishes and finalizes 'approved'; the raced reject is
	// kept outstanding, never completed over an unproven ordering — and the
	// stale reject intent never touches YouTube again (converge publishes).
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'published', false, 'access-token', undefined);
	expect(mocks.setModerationStatus).not.toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
	expectActionState('cancelling');
	expect(mocks.state.commentStatuses.comment).toBe('approved');
	expect(mocks.state.insertedAudits).not.toContainEqual(expect.objectContaining({ commentId: 'comment', action: 'reject', actor: 'system' }));

	// Next sweep: the corrective publish re-asserts the approved state — it
	// lands after any late-landing reject — then the row goes terminal.
	await runChannel('channel');
	expect(mocks.setModerationStatus).toHaveBeenLastCalledWith(['comment'], 'published', false, 'access-token', undefined);
	expect(mocks.setModerationStatus).not.toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
	expectActionState('superseded');
});

test('a reject write resolving after a rescan re-approval stays reconcilable', async () => {
	// codex: the write resolved but the comment re-decided 'approved'
	// meanwhile — the reject may land remotely AFTER whatever published it.
	// Completing the row would claim an ordering that never happened;
	// 'cancelling' makes the next sweep's corrective publish land last.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'rejected' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'reject' })];
	mocks.setModerationStatus.mockImplementationOnce(async () => {
		mocks.state.commentStatuses.comment = 'approved';
	});

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
	expectActionState('cancelling');

	await runChannel('channel');
	expect(mocks.setModerationStatus).toHaveBeenLastCalledWith(['comment'], 'published', false, 'access-token', undefined);
	expectActionState('superseded');
});

test('a dispatched action AGREEING with the human outcome completes at finalize', async () => {
	// Both writes land 'rejected' either way — ordering is irrelevant, so the
	// row completes and audits normally.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'restoring' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'reject' })];
	mocks.state.insertedAudits = [
		{ channelId: 'channel', commentId: 'comment', action: 'reject', reason: 'queue UI', actor: 'user', createdAt: '2026-01-04T00:00:01.000Z' }
	];

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
	expect(mocks.state.commentStatuses.comment).toBe('rejected');
	expectActionState('completed');
	expect(mocks.state.insertedAudits).toContainEqual(expect.objectContaining({ commentId: 'comment', action: 'reject', actor: 'system' }));
});

test('a comment claimed mid-convergence keeps its cancelling action outstanding', async () => {
	// codex: the corrective write lands, but a human restore claims the
	// comment ('restoring') while it was in flight — the pre-write status read
	// is stale. Superseding now would leave nothing outstanding while the two
	// remote writes' ordering is unprovable; the row must stay 'cancelling'
	// for the next sweep (or the human flow) to resolve.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'rejected' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'hold', state: 'cancelling' })];
	mocks.setModerationStatus.mockImplementationOnce(async () => {
		mocks.state.commentStatuses.comment = 'restoring';
	});

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
	expectActionState('cancelling');
});

test('a rescan replacing the restoring claim keeps its freshly staged action', async () => {
	// codex: finalizeHumanIntent guards its comment update on 'restoring' but
	// never checked whether a row matched — a rescan that replaced the claim
	// mid-write would still see its fresh pending action superseded.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'restoring' };
	mocks.state.insertedAudits = [
		{ channelId: 'channel', commentId: 'comment', action: 'reject', reason: 'queue UI', actor: 'user', createdAt: '2026-01-04T00:00:01.000Z' }
	];
	mocks.setModerationStatus.mockImplementationOnce(async () => {
		// The rescan stages a fresh verdict + action while the human's remote
		// write is in flight — the claim finalize relied on is gone.
		mocks.state.commentStatuses.comment = 'pending';
		mocks.state.moderationActions = [dispatchedAction({ action: 'reject', state: 'pending' })];
	});

	await runChannel('channel');

	// The rescan's pending reject survives: finalize owned no claim, so it
	// must not have terminalized the newer action row.
	expect(mocks.state.moderationActions).toEqual([expect.objectContaining({ commentId: 'comment', action: 'reject', state: 'pending' })]);
});

test('acted counts only rows this run terminalized — a failed corrective write is not counted', async () => {
	// codex: applicable.length was added wholesale — a hold whose corrective
	// write failed stayed outstanding yet still counted. It counts when a
	// later sweep completes it.
	mocks.state.existingIds = ['a', 'b'];
	mocks.state.commentStatuses = { a: 'held', b: 'held' };
	mocks.state.moderationActions = [
		dispatchedAction({ commentId: 'a', action: 'hold' }),
		dispatchedAction({ commentId: 'b', action: 'hold' })
	];
	mocks.setModerationStatus
		.mockImplementationOnce(async () => {
			// A human approves 'b' while the batch hold write is in flight.
			mocks.state.commentStatuses.b = 'approved';
		})
		.mockRejectedValueOnce(new Error('socket hang up')); // the corrective publish for b fails
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const result = await runChannel('channel');
		expect(result.acted).toBe(1);
		expect(mocks.state.moderationActions).toEqual([
			expect.objectContaining({ commentId: 'a', state: 'completed' }),
			expect.objectContaining({ commentId: 'b', state: 'dispatched' })
		]);
		expect(warning).toHaveBeenCalled();
	} finally {
		warning.mockRestore();
	}
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
	{ state: 'pending', published: false },
	{ state: 'dispatched', published: true }
])('a human decision supersedes an unapplied queue hold ($state) — it is never held', async ({ state, published }) => {
	// The review queue claimed the comment while its staged 'hold' was still
	// outstanding: the hold must not be applied after the fact. A row already
	// dispatched may have landed remotely, so the sweep writes the approved
	// state once to guarantee remote truth; a pending row never touched
	// YouTube and needs no write.
	mocks.state.existingIds = ['comment'];
	mocks.state.commentStatuses = { comment: 'approved' };
	mocks.state.moderationActions = [dispatchedAction({ action: 'hold', reason: 'ai score 0.60', state })];

	const result = await runChannel('channel');

	if (published) {
		expect(mocks.setModerationStatus).toHaveBeenCalledTimes(1);
		expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'published', false, 'access-token', undefined);
	} else {
		expectNoYoutubeWrites();
	}
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
	// convergence read, #4 the supersede re-check — flip to 'pending'
	// exactly at the re-check.
	mocks.state.onCommentsSelect = (callIndex) => {
		if (callIndex === 4) mocks.state.commentStatuses = { comment: 'pending' };
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

test('a missing comment during a crashed intent warns and finalizes the real outcome — deleted', async () => {
	// codex: the replayed 'reject' intent 404s — YouTube has no comment to
	// reject. Finalizing 'rejected' would record a remote state that does not
	// exist; the comment is gone, so the honest terminal status is 'deleted'.
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
	expect(mocks.state.insertedComments[0].status).toBe('deleted');
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
