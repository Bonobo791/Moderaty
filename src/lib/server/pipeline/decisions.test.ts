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

	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status, decidedBy: 'ai' })]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: audit, reason: `ai score ${score.toFixed(2)}` })
	]);
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

test('does not apply another channel’s rules', async () => {
	mocks.state.ruleRows = [
		{ id: 1, channelId: 'other-channel', type: 'keyword', pattern: 'comment', action: 'ban' },
		{ id: 2, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'hold' }
	];

	await runChannel('channel');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'heldForReview', false, 'access-token', undefined);
});

test('validates and compiles each regex rule once per run, not per comment', async () => {
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'regex', pattern: 'spam', action: 'hold' }];
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ id: 'a', text: 'spam one' }), newComment({ id: 'b', text: 'spam two' })],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.checkSync).toHaveBeenCalledTimes(1);
});

test('scores with the org-resolved OpenAI key (BYOK), threaded to both scorers', async () => {
	mocks.state.channel.orgId = 'org-1';
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.scoreTone.mockResolvedValue({ score: 0.2 });

	await runChannel('channel');

	expect(mocks.resolveOpenAiKey).toHaveBeenCalledWith('org-1');
	expect(mocks.scoreComment).toHaveBeenCalledWith('A comment', undefined, 'sk-resolved-key');
	expect(mocks.scoreTone).toHaveBeenCalledWith(
		'A comment',
		{ videoTitle: 'Video title', videoDescription: 'Video description' },
		undefined,
		{ protectLgbtqia: 0, protectWomen: 0 },
		'sk-resolved-key'
	);
});

test('routes AI scoring failures to the review queue instead of failing the run (I11)', async () => {
	mocks.scoreComment.mockRejectedValue(new Error('moderation response has missing or out-of-range category scores'));

	const result = await runChannel('channel');

	expectAiUnavailableQueued(result, { fetched: 1, partial: false, skipped: false });
});

test('redacts sensitive Error messages from the persisted audit reason', async () => {
	mocks.scoreComment.mockRejectedValue(new Error('OpenAI response Authorization: Bearer sk-secret-token'));

	const result = await runChannel('channel');

	expectAiUnavailableQueued(result);
	const audit = mocks.state.insertedAudits[0];
	expect(audit.reason).toBe('ai unavailable: scoring unavailable');
	expect(JSON.stringify(audit)).not.toContain('sk-secret-token');
	expect(JSON.stringify(audit)).not.toContain('Bearer');
});

test('never serializes a non-Error rejection into the audit reason (credentials stay out of the log)', async () => {
	// SDK/fetch rejections can carry enumerable credentials (Authorization
	// headers, response bodies). errorText must persist a safe scalar, never
	// JSON.stringify the object graph into the channel-visible reason.
	mocks.scoreComment.mockRejectedValue({
		code: 'ETIMEDOUT',
		request: { headers: { authorization: 'Bearer sk-secret-token' } }
	});

	const result = await runChannel('channel');

	expectAiUnavailableQueued(result, { fetched: 1, partial: false, skipped: false });
	const audit = mocks.state.insertedAudits[0];
	expect(JSON.stringify(audit)).not.toContain('sk-secret-token');
	expect(JSON.stringify(audit)).not.toContain('Bearer');
	// The safe scalar is still present.
	expect(audit.reason).toBe('ai unavailable: scoring unavailable');
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
		undefined,
		{ protectLgbtqia: 0, protectWomen: 0 },
		'sk-resolved-key'
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

test('continues rule and safety decisions when video metadata fails', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'comment', action: 'reject' }];
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.fetchVideoMetadata.mockRejectedValue(new Error('videos.list failed with 500'));

	const result = await runChannel('channel');

	expect(mocks.scoreComment).not.toHaveBeenCalled();
	expect(mocks.scoreTone).not.toHaveBeenCalled();
	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ status: 'rejected', decidedBy: 'rule' })]);
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['comment'], 'rejected', false, 'access-token', undefined);
	expect(result).toMatchObject({ fetched: 1, acted: 1, queued: 0, partial: false });
});

test('queues an unruled comment when video metadata fails', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.fetchVideoMetadata.mockRejectedValue(new Error('videos.list failed with 500'));

	const result = await runChannel('channel');

	expectAiUnavailableQueued(result);
	expect(mocks.scoreComment).not.toHaveBeenCalled();
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
		undefined,
		{ protectLgbtqia: 0, protectWomen: 0 },
		'sk-resolved-key'
	);
});

test('a protected handle is approved without rules, scoring, or enforcement — identity beats text', async () => {
	// A ban rule matches the comment text, but the protected handle decides
	// first: no rule decision, no AI call, no YouTube enforcement.
	protectHandle('author'); // newComment's default authorName is 'Author'
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'toxic', action: 'ban' }];
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ text: 'this is toxic' })],
		nextPageToken: null,
		reachedCursor: true
	});

	const result = await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([
		expect.objectContaining({ id: 'comment', status: 'approved', decidedBy: 'allowlist', matchedRuleId: null, aiScore: null })
	]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'approve', reason: 'protected handle', actor: 'system' })
	]);
	expect(mocks.state.moderationActions).toEqual([]);
	expect(mocks.scoreComment).not.toHaveBeenCalled();
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect(result).toMatchObject({ fetched: 1, acted: 0, queued: 0, dryRun: false });
});

test('only the protected identity is exempt — the same toxic text still bans another commenter in the same run', async () => {
	protectHandle('author');
	mocks.state.ruleRows = [{ id: 1, channelId: 'channel', type: 'keyword', pattern: 'toxic', action: 'ban' }];
	mocks.fetchNewComments.mockResolvedValue({
		comments: [
			newComment({ id: 'protected', text: 'this is toxic' }),
			newComment({ id: 'troll', authorName: 'Troll', authorChannelId: 'troll-id', text: 'this is toxic' })
		],
		nextPageToken: null,
		reachedCursor: true
	});

	const result = await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: 'protected', status: 'approved', decidedBy: 'allowlist' }),
		expect.objectContaining({ id: 'troll', status: 'rejected', decidedBy: 'rule', matchedRuleId: 1 })
	]));
	expect(mocks.state.moderationActions).toEqual([
		expect.objectContaining({ commentId: 'troll', action: 'ban', state: 'completed' })
	]);
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['troll'], 'rejected', true, 'access-token', undefined);
	expect(mocks.scoreComment).not.toHaveBeenCalled();
	expect(result).toMatchObject({ fetched: 2, acted: 1, queued: 0 });
});

test('an @-prefixed, mixed-case author name matches the normalized stored handle', async () => {
	protectHandle('some.user');
	mocks.fetchNewComments.mockResolvedValue({
		comments: [newComment({ authorName: '@Some.User' })],
		nextPageToken: null,
		reachedCursor: true
	});

	await runChannel('channel');

	expect(mocks.state.insertedComments).toEqual([
		expect.objectContaining({ id: 'comment', status: 'approved', decidedBy: 'allowlist' })
	]);
	expect(mocks.scoreComment).not.toHaveBeenCalled();
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

test('a ticked protection flag forces the tone pass even below sensitivity level 2', async () => {
	mocks.state.channel.toneLevel = 1;
	mocks.state.channel.protectLgbtqia = 0;
	mocks.state.channel.protectWomen = 1;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.scoreTone.mockResolvedValue({ score: 0.9 });

	const result = await runChannel('channel');

	// Video context is fetched and the persisted flags reach the scorer.
	expect(mocks.fetchVideoMetadata).toHaveBeenCalled();
	expect(mocks.scoreTone).toHaveBeenCalledWith(
		'A comment',
		{ videoTitle: 'Video title', videoDescription: 'Video description' },
		undefined,
		{ protectLgbtqia: 0, protectWomen: 1 },
		'sk-resolved-key'
	);
	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status: 'rejected' })]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'reject', reason: 'tone score 0.90' })
	]);
	expect(result).toMatchObject({ acted: 1, queued: 0 });
});

test('level 2 passes the persisted protection flags through to the scorer', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.state.channel.protectLgbtqia = 1;
	mocks.state.channel.protectWomen = 1;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));
	mocks.scoreTone.mockResolvedValue({ score: 0.2 });

	await runChannel('channel');

	expect(mocks.scoreTone).toHaveBeenCalledWith(
		'A comment',
		{ videoTitle: 'Video title', videoDescription: 'Video description' },
		undefined,
		{ protectLgbtqia: 1, protectWomen: 1 },
		'sk-resolved-key'
	);
});

test('no flags and sensitivity below 2 keeps the tone pass off (no extra AI spend)', async () => {
	mocks.state.channel.toneLevel = 1;
	mocks.state.channel.protectLgbtqia = 0;
	mocks.state.channel.protectWomen = 0;
	mocks.scoreComment.mockResolvedValue(moderation(0.1));

	await runChannel('channel');

	expect(mocks.fetchVideoMetadata).not.toHaveBeenCalled();
	expect(mocks.scoreTone).not.toHaveBeenCalled();
	expect(mocks.state.insertedComments).toEqual([expect.objectContaining({ id: 'comment', status: 'approved' })]);
});

test('skips the tone pass at exactly the auto-reject threshold (0.76)', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.76));

	await runChannel('channel');

	expect(mocks.scoreTone).not.toHaveBeenCalled();
	expect(mocks.state.insertedComments).toEqual([
		expect.objectContaining({ id: 'comment', status: 'rejected', decidedBy: 'ai' })
	]);
	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'reject', reason: 'ai score 0.76' })
	]);
});

test('keeps the ai signal when the tone score ties it', async () => {
	mocks.state.channel.toneLevel = 2;
	mocks.scoreComment.mockResolvedValue(moderation(0.6));
	mocks.scoreTone.mockResolvedValue({ score: 0.6 });

	await runChannel('channel');

	expect(mocks.state.insertedAudits).toEqual([
		expect.objectContaining({ commentId: 'comment', action: 'queue', reason: 'ai score 0.60' })
	]);
});
