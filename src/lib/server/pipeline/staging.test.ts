import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { auditLog, channelAllowedHandles, channels, comments, creditTransactions, moderationActions, organizations, rules } from '$lib/server/db/schema';
import {
	dispatchedAction,
	expectActionState,
	expectAiUnavailableQueued,
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

test('the organizations fake reports no row for an org that was never seeded', async () => {
	// The real ledger throws `org not found` for an unknown org — a fake that
	// invents a row for every id lets a run charge an org the harness never
	// seeded instead of failing loudly (codeant nitpick).
	mocks.state.channel.orgId = 'org-1';
	// Dynamic import like runChannel: a static top-level import evaluates the
	// ledger before this module's vi.mock('$lib/server/db') registers.
	const { orgIsMetered } = await import('$lib/server/billing/ledger');
	await expect(orgIsMetered('org-missing')).rejects.toThrow('org not found: org-missing');
	await expect(orgIsMetered('org-1')).resolves.toBe(true);
});

test('writes an approval audit entry for a low-risk AI decision', async () => {
	mocks.scoreComment.mockResolvedValue(moderation(0.34));

	await runChannel('channel');

	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({
		commentId: 'comment',
		action: 'approve',
		reason: 'ai score 0.34',
		actor: 'system'
	})]);
	// An approved comment has no YouTube action, so no moderation action row at all.
	expect(mocks.state.moderationActions).toEqual([]);
});

test('a dry run counts the protected comment as implicit approved and audits the approve intent', async () => {
	protectHandle('author');
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'toxic', action: 'ban' }];
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ text: 'this is toxic' })],
		nextPageToken: null,
		reachedCursor: true
	});

	const result = await runChannel('channel', { forceDryRun: true });

	// Neither acted nor queued: the implicit approved bucket (fetched − acted − queued).
	expect(result).toMatchObject({ fetched: 1, acted: 0, queued: 0, dryRun: true });
	expect(mocks.state.insertedComments).toEqual([]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'dry-run', reason: 'protected handle', authorHandle: 'author', text: 'this is toxic' })
	]);
	expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
	expect(mocks.scoreComment).not.toHaveBeenCalled();
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
});

test.each([
	{ score: 0.34, audit: 'approve', count: 1 },
	// A queued comment writes TWO rows carrying the handle: 'queue' at staging
	// (why it waits) and 'hold' at enforcement completion (the remote action).
	{ score: 0.6, audit: 'queue', count: 2 }
])('an auto-action ($audit) never treats an @-prefixed display name as a handle', async ({ score, audit, count }) => {
	// YouTube comments supply display names, not verified handles.
	mocks.scoreComment.mockResolvedValue(moderation(score));
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ authorName: '@Some.User' })],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.state.insertedAudits).toHaveLength(count);
	expect(mocks.state.insertedAudits).toEqual(expect.arrayContaining([
		expect.objectContaining({ commentId: 'comment', action: audit, authorHandle: null })
	]));
	if (audit === 'queue') {
		// The completion audit preserves NULL through the staged action.
		expect(mocks.state.insertedAudits).toContainEqual(expect.objectContaining({
			commentId: 'comment',
			action: 'hold',
			actor: 'system',
			authorHandle: null,
			reason: expect.any(String)
		}));
	}
});

test('a dry-run audit row keeps an unverified handle null alongside the capped text', async () => {
	// Even a handle-shaped display name cannot become a stored handle.
	mocks.state.env.DRY_RUN = 'false';
	mocks.scoreComment.mockResolvedValue(moderation(0.95));
	const text = `comment ${'x'.repeat(600)}`;
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ authorName: '@Mixed.Case', text })],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel', { forceDryRun: true });

	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({
			commentId: 'comment',
			action: 'dry-run',
			authorHandle: null,
			text: text.slice(0, 500)
		})
	]);
});

test('a blank display name leaves the unavailable handle null', async () => {
	// '@' is a display name, not a verified handle.
	mocks.scoreComment.mockResolvedValue(moderation(0.34));
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ authorName: '@' })],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'approve', authorHandle: null })
	]);
	expect(mocks.state.insertedAudits[0].authorHandle).toBeNull();
});

test('real enforcement keeps an unverified handle null in staged actions and completion audits', async () => {
	// The completion audit reads the action row after in-memory identity is gone.
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'toxic', action: 'ban' }];
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ authorName: '@Some.User', text: 'this is toxic' })],
		nextPageToken: null,
		reachedCursor: true
	});

	const result = await runChannel('channel');

	expect(mocks.state.moderationActions).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'ban', state: 'completed', authorHandle: null })
	]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'ban', authorHandle: null })
	]);
	expect(result).toMatchObject({ acted: 1, queued: 0 });
});

test('a display name of @ cannot produce a handle on a completed action', async () => {
	// Display-name formatting cannot invent an author handle.
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'toxic', action: 'ban' }];
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ authorName: '@', text: 'this is toxic' })],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.state.moderationActions).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'ban', authorHandle: null })
	]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'ban', authorHandle: null })
	]);
	expect(mocks.state.insertedAudits[0].authorHandle).toBeNull();
});

test('a completion audit row for a legacy action row with no stored handle stores null', async () => {
	// Rows staged before migration 0021 (or nulled by the retention sweep)
	// carry no handle — completion must write NULL, never crash or invent one.
	mocks.state.existingIds = ['comment'];
	mocks.state.moderationActions = [dispatchedAction({ authorHandle: null })];

	await runChannel('channel');

	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'ban', authorHandle: null })
	]);
	expect(mocks.state.insertedAudits[0].authorHandle).toBeNull();
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

	expect(mocks.scoreComment).toHaveBeenCalledWith(text, undefined, 'sk-resolved-key');
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

test('truncates the rule pattern in the stored reason at 80 characters', async () => {
	const pattern = 'p'.repeat(100);
	mocks.state.ruleRows = [{ id: 7, channelId: 'channel', type: 'keyword', pattern, action: 'reject' }];
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ text: `prefix ${pattern}` })],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	const reason = `rule #7 (keyword: ${pattern.slice(0, 80)})`;
	expect(mocks.state.insertedComments).toEqual([
		expect.objectContaining({ id: 'comment', status: 'rejected', decidedBy: 'rule', matchedRuleId: 7 })
	]);
	expect(mocks.state.moderationActions[0]).toEqual(expect.objectContaining({ reason }));
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'reject', reason, actor: 'system' })
	]);
	// Exactly one audit insert happens: completion, not an empty staging batch.
	expect(mocks.db.transactionValue.insert.mock.calls.filter(([table]) => table === auditLog)).toHaveLength(1);
});

test('truncates the ai-unavailable reason at 200 characters', async () => {
	mocks.scoreComment.mockRejectedValue(new Error('e'.repeat(300)));

	await runChannel('channel');

	// Exactly two rows: 'queue' (why it waits for a human) and 'hold' (the
	// remote action at enforcement completion) — no extra rows, and no raw
	// error text leaking into either reason field.
	expect(mocks.state.insertedAudits).toHaveLength(2);
	expect(mocks.state.insertedAudits).toContainEqual(expect.objectContaining({
		commentId: 'comment',
		action: 'queue',
		reason: 'ai unavailable: scoring unavailable',
		actor: 'system'
	}));
	expect(mocks.state.insertedAudits).toContainEqual(expect.objectContaining({
		commentId: 'comment',
		action: 'hold',
		reason: 'ai unavailable: scoring unavailable',
		actor: 'system'
	}));
});

test('a dry run counts only enforceable decisions as acted', async () => {
	mocks.state.env.DRY_RUN = 'true';
	mocks.scoreComment.mockResolvedValue(moderation(0.34));

	const result = await runChannel('channel');

	expect(result).toMatchObject({ fetched: 1, acted: 0, queued: 0, partial: false, skipped: false, dryRun: true });
	expect(mocks.state.insertedComments).toEqual([]);
	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({ commentId: 'comment', action: 'dry-run' })]);
});

test('a dry run with no new comments writes nothing at all', async () => {
	mocks.state.env.DRY_RUN = 'true';
	mocks.fetchNewComments.mockResolvedValue({ comments: [], nextPageToken: null, reachedCursor: true });

	const result = await runChannel('channel');

	expect(result).toEqual({ fetched: 0, acted: 0, queued: 0, partial: false, skipped: false, dryRun: true });
	expect(mocks.db.insert).not.toHaveBeenCalled();
	expect(mocks.state.insertedAudits).toEqual([]);
	expect(mocks.state.channelUpdates).toEqual([]);
});

test('staging inserts no empty action batch for an approved comment', async () => {
	mocks.scoreComment.mockResolvedValue(moderation(0.34));

	await runChannel('channel');

	// Two transaction inserts: the comments row and its approve audit. No empty
	// moderationActions batch is attempted.
	expect(mocks.db.transactionValue.insert).toHaveBeenCalledTimes(2);
	expect(mocks.db.transactionValue.insert).toHaveBeenCalledWith(comments);
	expect(mocks.db.transactionValue.insert).toHaveBeenCalledWith(auditLog);
	expect(mocks.db.transactionValue.insert).not.toHaveBeenCalledWith(moderationActions);
});

test.each([
	{ score: 0.8, audit: 'delete' },
	{ score: 0.95, audit: 'ban' }
])('a dry run still writes the audit row for an ai $audit decision', async ({ score }) => {
	// The dry-run audit covers every decision, including the ones that carry a
	// YouTube action — the auditAction field is what keeps the row in the set.
	mocks.state.env.DRY_RUN = 'true';
	mocks.scoreComment.mockResolvedValue(moderation(score));

	const result = await runChannel('channel');

	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'dry-run', text: 'A comment' })
	]);
	expect(result).toMatchObject({ fetched: 1, acted: 1, dryRun: true });
});
