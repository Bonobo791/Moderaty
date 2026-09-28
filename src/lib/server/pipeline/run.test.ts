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

test('resetPipelineMocks removes test-specific mock implementations', async () => {
	mocks.scoreComment.mockRejectedValue(new Error('stale implementation'));
	mocks.db.transaction.mockRejectedValueOnce(new Error('stale transaction'));
	resetPipelineMocks();

	const result = await runChannel('channel');

	expect(result).toMatchObject({ fetched: 1, partial: false, skipped: false });
	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ decidedBy: 'ai' })]);
});

test('the http mock surface is complete for the real youtube module it sits behind', async () => {
	// cubic, PR #142: importOriginal evaluates real youtube.ts under this
	// mock — every name it imports from $lib/server/http must exist, or an
	// un-stubbed real export fails confusingly with undefined-is-not-a-fn.
	const http = await import('$lib/server/http');
	expect(typeof http.fetchWithRetry).toBe('function');
	expect(typeof http.assertBeforeDeadline).toBe('function');
	expect(typeof http.DeadlineExceededError).toBe('function');
});

test('channel query mocks honor the requested channel id', async () => {
	await expect(runChannel('different-channel')).rejects.toThrow('channel not found: different-channel');
});

test('credit charge updates the fake balance across runs', async () => {
	mocks.state.channel.orgId = 'org-1';
	mocks.state.credits = 1;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));

	await runChannel('channel');
	mocks.fetchNewComments.mockResolvedValue({ comments: [newComment({ id: 'second' })], nextPageToken: null, reachedCursor: true });

	const second = await runChannel('channel');

	expect(second).toMatchObject({ outOfCredits: true });
	expect(mocks.state.insertedComments).toHaveLength(1);
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
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'delete' }];
	process.env.DRY_RUN = 'true';
	mocks.state.env.DRY_RUN = 'true';

	const result = await runChannel('channel');

	expect(mocks.scoreComment).not.toHaveBeenCalled();
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({
		commentId: 'comment',
		action: 'dry-run'
	})]);
	expect(result).toMatchObject({ fetched: 1, acted: 1, queued: 0, partial: false, skipped: false, dryRun: true });
});

test('reads DRY_RUN from private runtime environment variables', async () => {
	delete process.env.DRY_RUN;
	mocks.state.env.DRY_RUN = 'true';
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'delete' }];

	const result = await runChannel('channel');

	expect(result.dryRun).toBe(true);
	expect(mocks.deleteComment).not.toHaveBeenCalled();
});

test('forceDryRun previews a live deployment: dry-run audit rows carry the comment text and nothing durable changes', async () => {
	// The dashboard's on-demand preview runs against a LIVE deployment
	// (env DRY_RUN=false): same I8 guarantees as an env dry run, plus the
	// comment text on the audit row (comments rows are never written, so the
	// audit row is the only place the text survives). Text is capped at 500.
	mocks.state.env.DRY_RUN = 'false';
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'delete' }];
	const text = `comment ${'x'.repeat(600)}`;
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ text })],
		nextPageToken: null,
		reachedCursor: true
	});

	const result = await runChannel('channel', { forceDryRun: true });

	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
	expect(mocks.state.insertedComments).toEqual([]);
	expect(mocks.state.channelUpdates).toEqual([]);
	expect(mocks.state.insertedAudits).toEqual([expect.objectContaining({
		commentId: 'comment',
		action: 'dry-run',
		text: text.slice(0, 500)
	})]);
	expect(result).toMatchObject({ fetched: 1, acted: 1, queued: 0, partial: false, skipped: false, dryRun: true });
});

test('forceDryRun can only turn dry-run on — it never flips an env-dry deployment live', async () => {
	mocks.state.env.DRY_RUN = 'true';
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'delete' }];

	const result = await runChannel('channel', { forceDryRun: false });

	expect(result.dryRun).toBe(true);
	expect(mocks.deleteComment).not.toHaveBeenCalled();
});

test('window mode fetches one page bounded by the window, ignoring the live cursor and checkpoint', async () => {
	// The dry-run drain walks the window independently: the live cursor keeps
	// advancing on real runs, and a drain in flight never disturbs it.
	mocks.state.channel.cursor = '2026-06-01T00:00:00.000Z';
	mocks.state.channel.nextPageToken = 'live-token';

	const result = await runWindowPage({ pageToken: 'window-token' });

	expect(mocks.fetchNewComments).toHaveBeenCalledWith('channel', 'access-token', '2026-05-01T00:00:00.000Z', {
		maxPages: 1,
		pageToken: 'window-token',
		deadline: undefined
	});
	expect(mocks.state.channelUpdates).toEqual([]);
	expect(result).toMatchObject({ dryRun: true, windowComplete: true, windowNextPageToken: null });
});

test('window mode rescores comments already stored by real runs', async () => {
	// Re-scoring moderated comments is the entire point of the preview; the
	// stored-IDs dedupe would suppress every one of them.
	mocks.state.existingIds = ['comment'];

	const result = await runWindowPage();

	expect(mocks.scoreComment).toHaveBeenCalled();
	expect(result.fetched).toBe(1);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'dry-run', text: 'A comment' })
	]);
});

test('window mode reports continuation when the window has more pages, and persists nothing itself', async () => {
	const result = await runWindowPage({ nextPageToken: 'page-2', reachedCursor: false });

	expect(result).toMatchObject({ windowComplete: false, windowNextPageToken: 'page-2' });
	expect(mocks.state.channelUpdates).toEqual([]);
});

test('window mode is complete when the listing ends without hitting the boundary', async () => {
	// fetchNewComments clears nextPageToken whenever the listing is exhausted.
	// For an all-time window nothing ever trips the boundary, so THIS is the
	// only completion signal — reporting incomplete would hand cron a null
	// pageToken and restart the window from the top, rescoring it forever.
	const result = await runWindowPage({ nextPageToken: null, reachedCursor: false });

	expect(result).toMatchObject({ windowComplete: true, windowNextPageToken: null });
});

test('a planted history boundary rescores stored comments and charges under the scan id', async () => {
	// The owner asked to re-analyze the window: the stored-IDs dedupe is
	// skipped, the row upserts to the fresh verdict, and the charge anchors
	// to the per-request scan id — each requested scan debits once, retries
	// of THIS scan hit the same anchors and stage covered (I4).
	mocks.state.channel.orgId = 'org-1';
	mocks.state.credits = 10;
	mocks.state.channel.historyBoundary = '2026-01-01T00:00:00.000Z';
	mocks.state.channel.historyScanId = 'scan-req-1';
	mocks.state.existingIds = ['comment'];
	mocks.scoreComment.mockResolvedValue(moderation(0.9));

	const result = await runChannel('channel');

	expect(result).toMatchObject({ fetched: 1, acted: 1, dryRun: false });
	expect(mocks.scoreComment).toHaveBeenCalled();
	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', decidedBy: 'ai' })]);
	expect(mocks.state.insertedCredits).toEqual([expect.objectContaining({ refType: 'comment', refId: 'comment#scan-req-1' })]);
	// Completion clears the boundary AND its nonce together.
	expect(mocks.state.channelUpdates).toContainEqual(expect.objectContaining({ historyBoundary: null, historyScanId: null }));
});

test('a rescan channel with no scan id keeps the legacy plain comment anchor', async () => {
	// A drain planted before the nonce column existed already charged plain
	// comment ids on its earlier pages — minting a boundary-scoped anchor now
	// would debit those comments a second time (codex).
	mocks.state.channel.orgId = 'org-1';
	mocks.state.credits = 10;
	mocks.state.channel.historyBoundary = '2026-01-01T00:00:00.000Z';
	mocks.state.existingIds = ['comment'];
	mocks.state.insertedCredits = [{ orgId: 'org-1', refType: 'comment', refId: 'comment' }];
	mocks.scoreComment.mockResolvedValue(moderation(0.9));

	await runChannel('channel');

	// The pre-nonce anchor covers the retry — no second debit under any ref.
	expect(mocks.state.insertedCredits).toEqual([expect.objectContaining({ refId: 'comment' })]);
	expect(mocks.state.credits).toBe(10);
});

test('a stale run cannot clear a replanted history scan — the checkpoint write aborts', async () => {
	// The owner re-requested the window while this worker was still fetching:
	// the replant minted a fresh boundary+nonce that now owns the drain state.
	// The stale run's completion write carries the OLD scan identity — the
	// checkpoint guard must reject it instead of clearing the new scan
	// (codeant).
	mocks.state.channel.historyBoundary = '2026-01-01T00:00:00.000Z';
	mocks.state.channel.historyScanId = 'scan-req-1';
	mocks.state.existingIds = ['comment'];
	mocks.scoreComment.mockResolvedValue(moderation(0.9));
	mocks.fetchNewComments.mockImplementation(async () => {
		mocks.state.channel = {
			...mocks.state.channel,
			historyBoundary: '2026-02-01T00:00:00.000Z',
			historyScanId: 'scan-req-2',
			nextPageToken: null
		};
		return { comments: [newComment()], nextPageToken: null, reachedCursor: true };
	});

	await expect(runChannel('channel')).rejects.toThrow('checkpoint changed');

	expect(mocks.state.channel.historyScanId).toBe('scan-req-2');
	expect(mocks.state.channelUpdates).toEqual([]);
});

test('a rescan retry after a mid-drain crash stages covered — the committed anchor blocks a second debit', async () => {
	// Attempt 1 charged and staged the verdict, then died inside enforcement:
	// the drain state stays planted and the balance is spent. The retry must
	// not defer the paid comment to outOfCredits — the committed scan anchor
	// covers it, or the cursor parks forever on work already bought
	// (codex+cubic) — and it must not charge again (cubic: the crash model,
	// not a stale channel row, is what leaves the boundary planted). Because
	// charge and stage commit in one transaction, an anchored comment is
	// already staged — the retry skips it instead of re-scoring (codex).
	mocks.state.channel.orgId = 'org-1';
	mocks.state.credits = 1;
	mocks.state.channel.historyBoundary = '2026-01-01T00:00:00.000Z';
	mocks.state.channel.historyScanId = 'scan-req-1';
	mocks.state.existingIds = ['comment'];
	mocks.scoreComment.mockResolvedValue(moderation(0.9));
	mocks.assertBeforeDeadline.mockImplementationOnce(() => {
		throw new mocks.DeadlineExceededError('out of time');
	});

	const crashed = await runChannel('channel');

	expect(crashed).toMatchObject({ partial: true, stoppedReason: 'deadline' });
	expect(mocks.state.insertedCredits).toEqual([expect.objectContaining({ refId: 'comment#scan-req-1' })]);
	expect(mocks.state.credits).toBe(0);

	const retried = await runChannel('channel');

	expect(retried).toMatchObject({ fetched: 1, partial: false });
	expect(retried.outOfCredits).toBeUndefined();
	expect(mocks.state.insertedCredits.filter((row) => row.refId === 'comment#scan-req-1')).toHaveLength(1);
	expect(mocks.state.credits).toBe(0);
	// The covered comment was skipped on the retry: one AI call total, and its
	// committed action still completed through the enforcement sweep.
	expect(mocks.scoreComment).toHaveBeenCalledTimes(1);
	expect(mocks.state.moderationActions).toEqual([expect.objectContaining({ commentId: 'comment', state: 'completed' })]);
	expect(mocks.state.channelUpdates).toContainEqual(expect.objectContaining({ historyBoundary: null, historyScanId: null }));
});

test('a parked rescan page skips comments this scan already staged — no repeat AI, staging, or enforcement burn', async () => {
	// The scan staged+charged 'paid' but ran out of credits before 'unpaid':
	// the checkpoint parks at outOfCredits. Every later tick must reattempt
	// only the unpaid remainder — re-scoring 'paid' would burn an OpenAI call
	// and re-pend its completed action every tick until top-up (codex). The
	// committed action row still finishes through the normal sweep.
	mocks.state.channel.orgId = 'org-1';
	mocks.state.credits = 0;
	mocks.state.channel.historyBoundary = '2026-01-01T00:00:00.000Z';
	mocks.state.channel.historyScanId = 'scan-req-1';
	mocks.state.existingIds = ['paid', 'unpaid'];
	mocks.state.insertedCredits = [{ orgId: 'org-1', refType: 'comment', refId: 'paid#scan-req-1' }];
	mocks.state.moderationActions = [dispatchedAction({ commentId: 'paid', action: 'delete' })];
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ id: 'paid' }), newComment({ id: 'unpaid' })],
		nextPageToken: 'page-2',
		reachedCursor: false
	});
	mocks.getCommentModerationStatus.mockResolvedValue(null);

	const result = await runChannel('channel');

	expect(result.outOfCredits).toBe(true);
	expect(mocks.scoreComment).not.toHaveBeenCalled();
	expect(mocks.state.insertedComments).toEqual([]);
	expect(mocks.state.insertedCredits).toHaveLength(1);
	expect(mocks.state.moderationActions).toEqual([expect.objectContaining({ commentId: 'paid', state: 'completed' })]);
	// The page stays parked — only a top-up advances the checkpoint.
	expect(mocks.state.channelUpdates).toEqual([]);
});

test('skips an inactive channel without fetching or scoring', async () => {
	mocks.state.channel = { ...mocks.state.channel, active: 0 };

	const result = await runChannel('channel');

	expect(result).toEqual({ fetched: 0, acted: 0, queued: 0, partial: false, skipped: true, dryRun: false });
	expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
	expect(mocks.fetchNewComments).not.toHaveBeenCalled();
	expect(mocks.scoreComment).not.toHaveBeenCalled();
});

test('a preview whose claimed row was swapped aborts before any provider call', async () => {
	// delete+reconnect lands the same channel id on a fresh row and connector;
	// the claim fingerprint must gate EXECUTION, not only the writes — the
	// loaded row comparing equal to itself proves nothing (cubic+codeant).
	mocks.state.channel.orgId = 'org-1';
	mocks.state.channel.leaseExpiresAt = '2099-01-01T00:00:00.000Z';
	for (const claim of [
		{ orgId: 'org-2', refreshTokenEnc: 'encrypted-refresh-token', leaseExpiresAt: '2099-01-01T00:00:00.000Z' }, // reconnected under another org
		{ orgId: 'org-1', refreshTokenEnc: 'enc-reconnected', leaseExpiresAt: '2099-01-01T00:00:00.000Z' }, // same org, fresh grant ciphertext
		{ orgId: 'org-1', refreshTokenEnc: 'encrypted-refresh-token', leaseExpiresAt: '2099-02-02T00:00:00.000Z' } // lease lost to cron
	]) {
		await expect(
			runChannel('channel', { forceDryRun: true, window: { boundary: '2025-01-01T00:00:00.000Z', pageToken: null }, claim })
		).rejects.toThrow('changed under the dry-run claim');
	}
	expect(mocks.fetchNewComments).not.toHaveBeenCalled();
});

test('a preview claim matching the live row runs normally', async () => {
	mocks.state.channel.orgId = 'org-1';
	mocks.state.channel.leaseExpiresAt = '2099-01-01T00:00:00.000Z';
	const claim = { orgId: 'org-1', refreshTokenEnc: 'encrypted-refresh-token', leaseExpiresAt: '2099-01-01T00:00:00.000Z' };
	const result = await runChannel('channel', { forceDryRun: true, window: { boundary: '2025-01-01T00:00:00.000Z', pageToken: null }, claim });
	expect(result).toMatchObject({ skipped: false, dryRun: true });
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
	// No decisions means no staging transaction at all.
	expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
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

test('selects only the columns each lookup needs', async () => {
	mocks.scoreComment.mockResolvedValue(moderation(0.34));

	await runChannel('channel');

	expect(mocks.db.select).toHaveBeenCalledWith({ id: comments.id });
	expect(mocks.db.select).not.toHaveBeenCalledWith({ active: channels.active });
});

test('fails loudly when the channel does not exist', async () => {
	(mocks.state as { channel: unknown }).channel = undefined;

	await expect(runChannel('missing-channel')).rejects.toThrow('channel not found: missing-channel');

	expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
	expect(mocks.fetchNewComments).not.toHaveBeenCalled();
});

test('treats a vanished channel row as deactivated mid-run, logging and stopping loudly', async () => {
	const info = vi.spyOn(console, 'info').mockImplementation(() => {});
	mocks.scoreComment.mockImplementation(async () => {
		// Account deletion removes the channel row while the run is scoring.
		(mocks.state as { channel: unknown }).channel = undefined;
		return moderation(0.1);
	});

	const result = await runChannel('channel');

	expect(result).toEqual({ fetched: 1, acted: 0, queued: 0, partial: true, skipped: false, dryRun: false, stoppedReason: 'deactivated' });
	expect(mocks.state.insertedComments).toEqual([]);
	expect(info).toHaveBeenCalledWith(
		expect.stringContaining('stopping run for channel: channel deactivated mid-run: channel')
	);
	info.mockRestore();
});

test('returns a partial result when the deadline hits during comment fetch', async () => {
	mocks.fetchNewComments.mockRejectedValue(new mocks.DeadlineExceededError('out of time'));

	const result = await runChannel('channel');

	expect(result).toEqual({ fetched: 0, acted: 0, queued: 0, partial: true, skipped: false, dryRun: false, stoppedReason: 'deadline' });
	expect(mocks.state.insertedComments).toEqual([]);
	expect(mocks.state.channelUpdates).toEqual([]);
});

test('returns a partial result when the deadline hits during video metadata fetch', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.fetchVideoMetadata.mockRejectedValue(new mocks.DeadlineExceededError('out of time'));

	const result = await runChannel('channel');

	expect(result).toEqual({ fetched: 1, acted: 0, queued: 0, partial: true, skipped: false, dryRun: false, stoppedReason: 'deadline' });
	expect(mocks.state.insertedComments).toEqual([]);
});

test('returns a partial result when the deadline hits during omni scoring — nothing is queued or staged', async () => {
	// The scoring path must abort like the fetch/metadata/verification paths:
	// a deadline-expired score is NOT an AI failure to queue (I11), it is a
	// bounded-run abort (I10). Queuing it would dump the whole unprocessed
	// tail of a burst into the review queue and advance the cursor past it.
	mocks.scoreComment.mockRejectedValue(new mocks.DeadlineExceededError('out of time'));

	const result = await runChannel('channel');

	expect(result).toEqual({ fetched: 1, acted: 0, queued: 0, partial: true, skipped: false, dryRun: false, stoppedReason: 'deadline' });
	expect(mocks.state.insertedComments).toEqual([]);
	expect(mocks.state.insertedAudits).toEqual([]);
	expect(mocks.state.channelUpdates).toEqual([]);
});

test('returns a partial result when the deadline hits during tone scoring — nothing is queued or staged', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.scoreTone.mockRejectedValue(new mocks.DeadlineExceededError('out of time'));

	const result = await runChannel('channel');

	expect(result).toEqual({ fetched: 1, acted: 0, queued: 0, partial: true, skipped: false, dryRun: false, stoppedReason: 'deadline' });
	expect(mocks.state.insertedComments).toEqual([]);
	expect(mocks.state.insertedAudits).toEqual([]);
	expect(mocks.state.channelUpdates).toEqual([]);
});

test('fetches comments with the stored cursor, page token, and paging options', async () => {
	mocks.state.channel = {
		...mocks.state.channel,
		cursor: '2026-01-01T00:00:00.000Z',
		nextPageToken: 'page-2'
	};
	mocks.scoreComment.mockResolvedValue(moderation(0.34));

	await runChannel('channel', { maxPages: 5, deadline: 123456 });

	expect(mocks.fetchNewComments).toHaveBeenCalledWith('channel', 'access-token', '2026-01-01T00:00:00.000Z', {
		maxPages: 5,
		pageToken: 'page-2',
		deadline: 123456
	});
});

test('keeps the newest timestamp even when it appears first on the page', async () => {
	mocks.scoreComment.mockResolvedValue(moderation(0.34));
	mocks.fetchNewComments.mockResolvedValue({
		comments: [
			newComment({ id: 'newest', publishedAt: '2026-01-05T00:00:00.000Z' }),
			newComment({ id: 'oldest', publishedAt: '2026-01-01T00:00:00.000Z' })
		],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.state.channelUpdates).toContainEqual(
		expect.objectContaining({ cursor: '2026-01-05T00:00:00.000Z' })
	);
});

test('keeps the first timestamp when two comments share one instant', async () => {
	mocks.scoreComment.mockResolvedValue(moderation(0.34));
	mocks.fetchNewComments.mockResolvedValue({
		comments: [
			// Same instant as the next comment, expressed with a +05:30 offset.
			newComment({ id: 'first', publishedAt: '2026-01-04T05:00:00+05:30' }),
			newComment({ id: 'second', publishedAt: '2026-01-03T23:30:00.000Z' })
		],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.state.channelUpdates).toContainEqual(
		expect.objectContaining({ cursor: '2026-01-04T05:00:00+05:30' })
	);
});

test('window mode without dry-run semantics fails loudly — it can never go live', async () => {
	// The window rescore skips the stored-IDs dedupe, so a live window run
	// would stage duplicate decisions and enforce on re-fetched comments. The
	// combination must be structurally impossible, not just undocumented.
	mocks.state.env.DRY_RUN = 'false';

	await expect(
		runChannel('channel', { window: { boundary: '2026-05-01T00:00:00.000Z', pageToken: null } })
	).rejects.toThrow('window mode requires dry-run');
	expect(mocks.fetchNewComments).not.toHaveBeenCalled();
	expect(mocks.state.insertedAudits).toEqual([]);
});

describe('credit consumption (billing)', () => {
	test('consumes one credit per staged comment on a live run and advances the cursor', async () => {
		mocks.state.channel.orgId = 'org-1';
		mocks.state.credits = 5;
		mocks.scoreComment.mockResolvedValue(moderation(0.1));
		mocks.fetchNewComments.mockResolvedValue({
			comments: [newComment({ id: 'a' }), newComment({ id: 'b' })],
			nextPageToken: null,
			reachedCursor: true
		});

		const result = await runChannel('channel');

		expect(mocks.state.insertedComments).toHaveLength(2);
		expect(mocks.state.insertedCredits).toEqual([
			expect.objectContaining({ orgId: 'org-1', delta: -1, reason: 'consume', refType: 'comment', refId: 'a' }),
			expect.objectContaining({ orgId: 'org-1', delta: -1, reason: 'consume', refType: 'comment', refId: 'b' })
		]);
		// Cursor advanced (persistResults ran) and no out-of-credits flag.
		expect(mocks.state.channelUpdates.some((update) => 'cursor' in update || 'scanCursor' in update)).toBe(true);
		expect(result).toMatchObject({ fetched: 2, dryRun: false });
		expect(result.outOfCredits).toBeUndefined();
	});

	test('at zero credits AI comments are deferred, nothing stages, and the cursor parks', async () => {
		mocks.state.channel.orgId = 'org-1';
		mocks.state.credits = 0;
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.scoreComment.mockResolvedValue(moderation(0.5));

		const result = await runChannel('channel');

		expect(result.outOfCredits).toBe(true);
		// No decision staged, no AI call made, no audit row, no cursor update.
		expect(mocks.state.insertedComments).toEqual([]);
		expect(mocks.state.insertedAudits).toEqual([]);
		expect(mocks.state.insertedCredits).toEqual([]);
		expect(mocks.scoreComment).not.toHaveBeenCalled();
		expect(mocks.state.channelUpdates).toEqual([]);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('out of credits for org org-1'));
		errorSpy.mockRestore();
	});

	test('treats an invalid AI budget as exhausted instead of spending it', async () => {
		mocks.state.channel.orgId = 'org-1';
		mocks.state.customerId = 'cus-1';
		mocks.state.credits = Number.NaN;
		mocks.scoreComment.mockResolvedValue(moderation(0.1));

		const result = await runChannel('channel');

		expect(mocks.scoreComment).not.toHaveBeenCalled();
		expect(result).toMatchObject({ acted: 0, queued: 0, outOfCredits: true });
	});

	test('meters AI per comment: with 1 credit only the first AI comment is scored, the rest defer', async () => {
		mocks.state.channel.orgId = 'org-1';
		mocks.state.credits = 1;
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.scoreComment.mockResolvedValue(moderation(0.1));
		mocks.fetchNewComments.mockResolvedValue({
			comments: [newComment({ id: 'a' }), newComment({ id: 'b' }), newComment({ id: 'c' })],
			nextPageToken: null,
			reachedCursor: true
		});

		const result = await runChannel('channel');

		// AI ran for exactly one comment (the budget), not the whole page.
		expect(mocks.scoreComment).toHaveBeenCalledTimes(1);
		expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'a' })]);
		expect(mocks.state.insertedCredits).toEqual([
			expect.objectContaining({ orgId: 'org-1', delta: -1, reason: 'consume', refType: 'comment', refId: 'a' })
		]);
		// The two unpaid comments defer and the cursor parks for a post-top-up retry.
		expect(result.outOfCredits).toBe(true);
		expect(mocks.state.channelUpdates).toEqual([]);
		errorSpy.mockRestore();
	});

	test('an org that never engaged billing (NULL balance, no Stripe customer) scores AI unlimited and consumes nothing', async () => {
		// Self-hosted and lifetime-plan orgs are unmetered: no balance and no
		// Stripe customer means the credit gate must not engage at all.
		mocks.state.channel.orgId = 'org-1';
		mocks.state.credits = null;
		mocks.state.customerId = null;
		mocks.scoreComment.mockResolvedValue(moderation(0.1));
		mocks.fetchNewComments.mockResolvedValue({
			comments: [newComment({ id: 'a' }), newComment({ id: 'b' })],
			nextPageToken: null,
			reachedCursor: true
		});

		const result = await runChannel('channel');

		expect(mocks.scoreComment).toHaveBeenCalledTimes(2);
		expect(mocks.state.insertedComments).toHaveLength(2);
		// NULL balance: consumeCredit's guard rejects every charge — no ledger rows.
		expect(mocks.state.insertedCredits).toEqual([]);
		expect(result.outOfCredits).toBeUndefined();
		expect(mocks.state.channelUpdates.some((update) => 'cursor' in update || 'scanCursor' in update)).toBe(true);
	});

	test('an org with only a Stripe customer (checkout opened, never purchased) is UNmetered: AI scores unlimited', async () => {
		// Metering means a successful credit PURCHASE (non-null balance). A
		// customer alone only proves a Checkout was opened — it must never flip
		// a pre-billing org into the credit gate (codex 6133).
		mocks.state.channel.orgId = 'org-1';
		mocks.state.credits = null;
		mocks.state.customerId = 'cus_1';
		mocks.scoreComment.mockResolvedValue(moderation(0.5));

		const result = await runChannel('channel');

		expect(result.outOfCredits).toBeUndefined();
		expect(mocks.scoreComment).toHaveBeenCalled();
		expect(mocks.state.insertedCredits).toEqual([]);
	});

	test('a lifetime org holding a stranded balance scores AI unlimited and burns none of it', async () => {
		// The org bought credits while metered, then upgraded to lifetime: the
		// balance freezes — scoring is unlimited and consumeCredit no-ops for
		// unmetered plans (MOD-36). Staging can never abort on a failed charge.
		mocks.state.channel.orgId = 'org-1';
		mocks.state.plan = 'lifetime';
		mocks.state.credits = 500;
		mocks.scoreComment.mockResolvedValue(moderation(0.1));
		mocks.fetchNewComments.mockResolvedValue({
			comments: [newComment({ id: 'a' }), newComment({ id: 'b' })],
			nextPageToken: null,
			reachedCursor: true
		});

		const result = await runChannel('channel');

		expect(mocks.scoreComment).toHaveBeenCalledTimes(2);
		expect(mocks.state.insertedComments).toHaveLength(2);
		expect(mocks.state.insertedCredits).toEqual([]);
		expect(mocks.state.credits).toBe(500); // frozen — never burned
		expect(result.outOfCredits).toBeUndefined();
	});

	test('a comment whose credit charge FAILS (balance exhausted concurrently) aborts the staging — never stages free', async () => {
		// Two concurrent cron invocations on different channels of the same
		// metered org can both read the same balance into their in-memory AI
		// budget. Once one transaction exhausts the balance, the other's
		// consumeCredit returns false — and that decision must NOT stage for
		// free: the batch aborts loudly (nothing durable), the comments stay
		// unprocessed, and the next run retries them once the org tops up
		// (codex review).
		mocks.state.channel.orgId = 'org-1';
		mocks.state.credits = 5; // the in-memory AI budget reads 5...
		mocks.state.failCharges = true; // ...but the atomic charge finds 0
		mocks.scoreComment.mockResolvedValue(moderation(0.1));
		mocks.fetchNewComments.mockResolvedValue({
			comments: [newComment({ id: 'a' }), newComment({ id: 'b' })],
			nextPageToken: null,
			reachedCursor: true
		});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(runChannel('channel')).rejects.toThrow(/credit charge failed/);

		// No ledger or staging rows were committed; the run did not advance.
		expect(mocks.state.insertedCredits).toEqual([]);
		expect(mocks.state.insertedComments).toEqual([]);
		expect(mocks.state.insertedAudits).toEqual([]);
		expect(mocks.state.moderationActions).toEqual([]);
		errorSpy.mockRestore();
	});

	test('rule decisions stage, free of charge', async () => {
		// A POSITIVE balance makes the assertion meaningful: if stageDecisions
		// charged rule decisions, a consume row would land here and the test
		// would fail (codex 6167 / coderabbit).
		mocks.state.channel.orgId = 'org-1';
		mocks.state.credits = 5;
		mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'regex', pattern: 'spam', action: 'hold' }];
		mocks.fetchNewComments.mockResolvedValue({
			comments: [newComment({ id: 'a', text: 'spam one' })],
			nextPageToken: null,
			reachedCursor: true
		});

		const result = await runChannel('channel');

		expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'a', decidedBy: 'rule', status: 'held' })]);
		expect(mocks.state.insertedCredits).toEqual([]);
		expect(result.outOfCredits).toBeUndefined();
		expect(mocks.state.channelUpdates.some((update) => 'cursor' in update || 'scanCursor' in update)).toBe(true);
	});

	test('with credits available, only AI decisions consume credits — rule matches are free', async () => {
		mocks.state.channel.orgId = 'org-1';
		mocks.state.credits = 1;
		mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'regex', pattern: 'spam', action: 'hold' }];
		mocks.scoreComment.mockResolvedValue(moderation(0.9));
		mocks.fetchNewComments.mockResolvedValue({
			comments: [newComment({ id: 'a', text: 'spam one' }), newComment({ id: 'b', text: 'free text' })],
			nextPageToken: null,
			reachedCursor: true
		});

		const result = await runChannel('channel');

		expect(result.outOfCredits).toBeUndefined();
		// Only the AI-scored comment 'b' may consume the sole credit; the rule
		// match 'a' must stage free.
		expect(mocks.state.insertedCredits).toEqual([expect.objectContaining({ refId: 'b' })]);
		expect(mocks.state.insertedCredits).not.toEqual([expect.objectContaining({ refId: 'a' })]);
	});

	test('a dry run at zero credits still scores with AI and consumes nothing', async () => {
		mocks.state.channel.orgId = 'org-1';
		mocks.state.credits = 0;
		mocks.state.env.DRY_RUN = 'true';
		mocks.scoreComment.mockResolvedValue(moderation(0.1));

		const result = await runChannel('channel', { forceDryRun: true });

		expect(mocks.scoreComment).toHaveBeenCalled();
		expect(mocks.state.insertedAudits).toEqual([
			expect.objectContaining({ commentId: 'comment', action: 'dry-run' })
		]);
		expect(mocks.state.insertedCredits).toEqual([]);
		expect(result).toMatchObject({ dryRun: true });
		expect(result.outOfCredits).toBeUndefined();
	});
});
