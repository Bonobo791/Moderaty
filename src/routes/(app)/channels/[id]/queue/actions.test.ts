// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { beforeEach, expect, test, vi } from 'vitest';
import { TEST_OWNER, postForm, setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, comments, moderationActions } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	env: { DRY_RUN: 'true' } as Record<string, string | undefined>,
	refreshAccessToken: vi.fn(async (_token?: string) => 'access-token'),
	setModerationStatus: vi.fn(async (_ids: string[], _status: string, _ban?: boolean, _token?: string, _deadline?: number) => {}),
	deleteComment: vi.fn(async (_id: string, _token?: string, _deadline?: number) => {}),
	getCommentModerationStatus: vi.fn(async (_id: string, _token?: string, _deadline?: number) => null as string | null)
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/crypto', () => ({ decrypt: vi.fn(() => 'decrypted-refresh-token') }));
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: mocks.refreshAccessToken,
	setModerationStatus: mocks.setModerationStatus,
	deleteComment: mocks.deleteComment,
	getCommentModerationStatus: mocks.getCommentModerationStatus
}));

import { actions, load } from './+page.server';

setupTestDb(['audit_log', 'comments', 'channels', 'moderation_actions']);

beforeEach(async () => {
	await testDb()
		.db.insert(channels)
		.values([
			{ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'One', refreshTokenEnc: 'enc-1' },
			{ id: 'UC2', userId: OWNER.id, orgId: 'org-1', title: 'Two', refreshTokenEnc: 'enc-2' }
		]);
	mocks.env.DRY_RUN = 'true';
	vi.clearAllMocks();
	// vi.clearAllMocks clears call history but NOT implementations — re-seed
	// the defaults or a resolved value from one test.each iteration leaks
	// into the next.
	mocks.refreshAccessToken.mockResolvedValue('access-token');
	mocks.setModerationStatus.mockResolvedValue(undefined);
	mocks.deleteComment.mockResolvedValue(undefined);
	mocks.getCommentModerationStatus.mockResolvedValue(null);
});

const QUEUE_URL = 'http://localhost/channels/UC1/queue';

const OWNER = TEST_OWNER;

const actionNames = ['approve', 'reject', 'del', 'ban'] as const;

function act(name: (typeof actionNames)[number], fields: Record<string, string>, channelId = 'UC1', user: typeof OWNER | null = OWNER) {
	return actions[name]({ params: { id: channelId }, request: postForm(fields, QUEUE_URL), locals: { user } } as never);
}

async function expectAllActions404(fields: Record<string, string>) {
	for (const name of actionNames) {
		await expect(act(name, fields)).rejects.toThrowError(expect.objectContaining({ status: 404 }));
	}
}

async function seedComment(id: string, channelId: string, status = 'pending') {
	await testDb().db.insert(comments).values({
		id,
		channelId,
		text: 'hello',
		publishedAt: '2026-01-01T00:00:00Z',
		status,
		decidedBy: 'ai'
	});
}

/** The 'hold' moderation action the pipeline stages for a queued comment. */
async function seedHold(commentId: string, channelId: string, state = 'completed') {
	await testDb().db.insert(moderationActions).values({
		commentId,
		channelId,
		action: 'hold',
		reason: 'ai score 0.60',
		state,
		lastAttemptAt: null,
		lastManualRetryAt: null
	});
}

/** Queues 'c1' with a staged 'hold' in `state`, then approves it (DRY_RUN off). */
async function approveHeldComment(state: string) {
	mocks.env.DRY_RUN = 'false';
	await seedComment('c1', 'UC1');
	await seedHold('c1', 'UC1', state);
	const res = await act('approve', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Approved — recorded in audit log.' });
}

async function commentRow(id: string) {
	return testDb().db.select().from(comments).where(eq(comments.id, id)).get();
}

async function auditRows() {
	return testDb().db.select().from(auditLog).all();
}

async function expectNothingDecided(id: string, status: string) {
	expect((await commentRow(id))?.status).toBe(status);
	expect(await auditRows()).toHaveLength(0);
	expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
	expect(mocks.getCommentModerationStatus).not.toHaveBeenCalled();
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
}

/**
 * A minimal YouTube remote-state simulator: getCommentModerationStatus
 * reads `remote`, the writes update it. Tests drive `remote` mid-flight to
 * model a hold landing behind a human decision.
 */
function simulateYouTube(initial: string | null) {
	const yt = { remote: initial as string | null };
	mocks.getCommentModerationStatus.mockImplementation(async () => yt.remote);
	mocks.setModerationStatus.mockImplementation(async (_ids: string[], status: string) => {
		yt.remote = status;
	});
	mocks.deleteComment.mockImplementation(async () => {
		yt.remote = null;
	});
	return yt;
}

test('load projects only the channel fields the page renders — never the credential', async () => {
	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	expect(result?.ch).toEqual({ id: 'UC1', title: 'One' });
	expect(result?.ch).not.toHaveProperty('refreshTokenEnc');
});

test('every action rejects a signed-out request with 401 before validating the form', async () => {
	for (const name of actionNames) {
		await expect(act(name, {}, 'UC1', null)).rejects.toThrowError(expect.objectContaining({ status: 401 }));
	}
});

test('every action rejects a missing commentId with 400 and mutates nothing', async () => {
	await seedComment('c1', 'UC1');
	for (const name of actionNames) {
		const res = await act(name, {});
		expect(res).toMatchObject({ status: 400, data: { error: 'Invalid comment ID' } });
	}
	await expectNothingDecided('c1', 'pending');
});

test('a whitespace-padded commentId is trimmed before lookup', async () => {
	await seedComment('c1', 'UC1');
	const res = await act('approve', { commentId: '  c1\t' });
	expect(res).toMatchObject({ success: 'Approved — recorded in audit log.' });
	expect((await commentRow('c1'))?.status).toBe('approved');
});

test('act fails loudly on another channel comment and changes nothing', async () => {
	await seedComment('c2', 'UC2');
	await expectAllActions404({ commentId: 'c2' });
	await expectNothingDecided('c2', 'pending');
});

test('a 404 on an unknown pending comment names the problem', async () => {
	await expect(act('approve', { commentId: 'nope' })).rejects.toThrowError(
		expect.objectContaining({ status: 404, body: { message: 'pending comment not found in this channel' } })
	);
});

test('act fails loudly on a comment that is no longer pending', async () => {
	await seedComment('c3', 'UC1', 'approved');
	await expectAllActions404({ commentId: 'c3' });
	expect((await commentRow('c3'))?.decidedBy).toBe('ai');
	await expectNothingDecided('c3', 'approved');
});

test('a second act on an already-claimed comment 404s and audits nothing new', async () => {
	await seedComment('c1', 'UC1');
	await act('approve', { commentId: 'c1' });

	await expect(act('reject', { commentId: 'c1' })).rejects.toThrowError(expect.objectContaining({ status: 404 }));

	expect((await commentRow('c1'))?.status).toBe('approved');
	expect(await auditRows()).toHaveLength(1);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
});

test('a failed YouTube call releases the claim so the action stays retryable', async () => {
	// The failure surfaces as a form failure in the error-box — not a bare
	// 500 page — and the comment returns to the queue for a retry.
	mocks.env.DRY_RUN = 'false';
	const yt = simulateYouTube('published');
	mocks.setModerationStatus.mockRejectedValueOnce(new Error('youtube 500'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	await seedComment('c1', 'UC1');

	const res = await act('reject', { commentId: 'c1' });
	expect(res).toMatchObject({ status: 500, data: { error: 'The YouTube action failed — the comment is back in the queue. Try again.' } });

	expect(await commentRow('c1')).toMatchObject({ status: 'pending', decidedBy: 'none' });
	expect(await auditRows()).toHaveLength(0);

	// The retry goes through.
	const retry = await act('reject', { commentId: 'c1' });
	expect(retry).toMatchObject({ success: 'Rejected — recorded in audit log.' });
	expect((await commentRow('c1'))?.status).toBe('rejected');
	expect(yt.remote).toBe('rejected');
});

test('a crashed claim leaves durable intent — not a decided comment', async () => {
	// I3: the claim transaction commits 'restoring' + the intent audit row
	// BEFORE any remote call. Inside the remote write the comment must
	// already read 'restoring' with its intent recorded — a crash here is
	// what the reconcile sweep finishes, never a final status with
	// unapplied remote work.
	mocks.env.DRY_RUN = 'false';
	const yt = simulateYouTube('published');
	let during: { status: string | undefined; audits: number } | null = null;
	mocks.setModerationStatus.mockImplementation(async (_ids: string[], status: string) => {
		during ??= { status: (await commentRow('c1'))?.status, audits: (await auditRows()).length };
		yt.remote = status;
	});
	await seedComment('c1', 'UC1');

	await act('reject', { commentId: 'c1' });

	expect(during).toEqual({ status: 'restoring', audits: 1 });
	expect((await commentRow('c1'))?.status).toBe('rejected');
});

test('a failed human action re-arms a hold enforcement superseded mid-claim', async () => {
	// partitionHolds marks a hold 'superseded' the moment a human claim
	// commits a decided status. If the remote call then fails, the comment
	// returns to 'pending' — and the hold must return to 'pending' too, or
	// the comment sits in the queue public on YouTube while the page calls
	// it held ('superseded' is terminal; nothing retries it).
	mocks.env.DRY_RUN = 'false';
	simulateYouTube('published');
	mocks.setModerationStatus.mockRejectedValueOnce(new Error('youtube 500'));
	const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	await seedComment('c1', 'UC1');
	await seedHold('c1', 'UC1', 'superseded');

	const res = await act('reject', { commentId: 'c1' });

	expect(res).toMatchObject({ status: 500 });
	expect(await commentRow('c1')).toMatchObject({ status: 'pending', decidedBy: 'none' });
	const hold = await testDb().db.select().from(moderationActions).where(eq(moderationActions.commentId, 'c1')).get();
	expect(hold?.state).toBe('pending');
	// The real error is logged server-side; the client sees a generic message.
	expect(consoleSpy).toHaveBeenCalled();
	expect((res as { data?: { error?: string } }).data?.error).not.toContain('youtube 500');
});

test('a failed human action leaves a dispatched hold for the reconcile loop', async () => {
	// A 'dispatched' hold may be in flight to YouTube — the reconcile loop
	// re-verifies it against the restored 'pending' comment. Only
	// terminally-'superseded' holds are re-armed.
	mocks.env.DRY_RUN = 'false';
	simulateYouTube('published');
	mocks.setModerationStatus.mockRejectedValueOnce(new Error('youtube 500'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	await seedComment('c1', 'UC1');
	await seedHold('c1', 'UC1', 'dispatched');

	await act('reject', { commentId: 'c1' });

	const hold = await testDb().db.select().from(moderationActions).where(eq(moderationActions.commentId, 'c1')).get();
	expect(hold?.state).toBe('dispatched');
});

test('approve in DRY_RUN finalizes locally, audits dry-run, and skips YouTube', async () => {
	await seedComment('c1', 'UC1');
	const res = await act('approve', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Approved — recorded in audit log.' });

	const row = await commentRow('c1');
	expect(row?.status).toBe('approved');
	expect(row?.decidedBy).toBe('human');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'dry-run', actor: 'user' });

	expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
});

test('reject outside DRY_RUN calls YouTube and audits reject', async () => {
	mocks.env.DRY_RUN = 'false';
	simulateYouTube('published');
	await seedComment('c1', 'UC1');
	const res = await act('reject', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Rejected — recorded in audit log.' });

	expect(mocks.refreshAccessToken).toHaveBeenCalledWith('decrypted-refresh-token');
	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(1);
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'rejected', false, 'access-token', undefined);
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect((await commentRow('c1'))?.status).toBe('rejected');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	// authorHandle is null: manual actions have no handle source (the author's
	// name is never persisted on the comment row by design).
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'reject', reason: 'manual review', actor: 'user', authorHandle: null });
});

test('approve outside DRY_RUN on an already-public comment writes nothing and audits approve', async () => {
	mocks.env.DRY_RUN = 'false';
	simulateYouTube('published');
	await seedComment('c1', 'UC1');
	const res = await act('approve', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Approved — recorded in audit log.' });

	expect(mocks.getCommentModerationStatus).toHaveBeenCalledWith('c1', 'access-token', undefined);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect((await commentRow('c1'))?.status).toBe('approved');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'approve', reason: 'manual review', actor: 'user' });
});

test('approve outside DRY_RUN publishes a comment the pipeline held on YouTube', async () => {
	// Queue items under the hold contract are genuinely non-public on YouTube:
	// approving one must un-hold it or it stays invisible forever.
	simulateYouTube('heldForReview');
	await approveHeldComment('completed');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'published', false, 'access-token', undefined);
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect((await commentRow('c1'))?.status).toBe('approved');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'approve', actor: 'user' });
});

test('approve skips the publish call when the comment is already public remotely', async () => {
	// A 'pending' hold at claim time can never have reached YouTube — and the
	// preflight proves the comment is public, so no un-hold call is needed.
	simulateYouTube('published');
	await approveHeldComment('pending');

	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect((await commentRow('c1'))?.status).toBe('approved');
});

test.each([
	{ observed: 'heldForReview', publishes: true },
	{ observed: 'rejected', publishes: true },
	{ observed: 'likelySpam', publishes: true },
	{ observed: 'published', publishes: false }
])('approve publishes ANY non-public remote state, not just heldForReview (observed: $observed)', async ({ observed, publishes }) => {
	// YouTube's own systems can leave a queued comment 'rejected' or
	// 'likelySpam' — publishing only 'heldForReview' would approve locally
	// while the comment stays invisible forever.
	simulateYouTube(observed);
	await approveHeldComment('dispatched');

	expect(mocks.getCommentModerationStatus).toHaveBeenCalledWith('c1', 'access-token', undefined);
	if (publishes) {
		expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'published', false, 'access-token', undefined);
	} else {
		expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	}
	expect((await commentRow('c1'))?.status).toBe('approved');
});

test('a hold landing behind the approval is re-published by the post-write verify', async () => {
	// The dispatched hold lands behind the preflight read AND behind the
	// first publish: preflight 'published' → confirm 'heldForReview' →
	// publish → still 'heldForReview' → publish again → 'published'. The
	// final remote state must match the human decision — never 'approved'
	// locally while YouTube still hides the comment.
	mocks.env.DRY_RUN = 'false';
	const seen = ['published', 'heldForReview', 'heldForReview', 'published'];
	let reads = 0;
	mocks.getCommentModerationStatus.mockImplementation(async () => seen[Math.min(reads++, seen.length - 1)]);
	await seedComment('c1', 'UC1');
	await seedHold('c1', 'UC1', 'dispatched');

	const res = await act('approve', { commentId: 'c1' });

	expect(res).toMatchObject({ success: 'Approved — recorded in audit log.' });
	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(2);
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'published', false, 'access-token', undefined);
	expect((await commentRow('c1'))?.status).toBe('approved');
});

test('a dispatched hold verified as landed is completed and audited before the human action finalizes', async () => {
	// The hold really reached YouTube — completeActions never saw it (the
	// human claim superseded first), so finalize writes the 'hold' audit row
	// itself or the log never records the comment was hidden.
	mocks.env.DRY_RUN = 'false';
	simulateYouTube('heldForReview');
	await seedComment('c1', 'UC1');
	await seedHold('c1', 'UC1', 'dispatched');

	await act('approve', { commentId: 'c1' });

	const hold = await testDb().db.select().from(moderationActions).where(eq(moderationActions.commentId, 'c1')).get();
	expect(hold?.state).toBe('completed');
	const audits = await auditRows();
	expect(audits).toHaveLength(2);
	expect(audits.map((row) => `${row.action}:${row.actor}`).sort()).toEqual(['approve:user', 'hold:system']);
});

test('a never-landed hold is superseded at finalize — no phantom hold audit', async () => {
	mocks.env.DRY_RUN = 'false';
	simulateYouTube('published');
	await seedComment('c1', 'UC1');
	await seedHold('c1', 'UC1', 'pending');

	await act('approve', { commentId: 'c1' });

	const hold = await testDb().db.select().from(moderationActions).where(eq(moderationActions.commentId, 'c1')).get();
	expect(hold?.state).toBe('superseded');
	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0].action).toBe('approve');
});

test('del outside DRY_RUN deletes on YouTube, marks deleted, and audits delete', async () => {
	mocks.env.DRY_RUN = 'false';
	simulateYouTube('published');
	await seedComment('c1', 'UC1');
	const res = await act('del', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Deleted — recorded in audit log.' });

	expect(mocks.refreshAccessToken).toHaveBeenCalledWith('decrypted-refresh-token');
	expect(mocks.deleteComment).toHaveBeenCalledTimes(1);
	expect(mocks.deleteComment).toHaveBeenCalledWith('c1', 'access-token', undefined);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect((await commentRow('c1'))?.status).toBe('deleted');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'delete', reason: 'manual review', actor: 'user' });
});

test('ban outside DRY_RUN rejects with the author ban on YouTube and audits ban', async () => {
	mocks.env.DRY_RUN = 'false';
	simulateYouTube('published');
	await seedComment('c1', 'UC1');
	const res = await act('ban', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Author banned — recorded in audit log.' });

	expect(mocks.refreshAccessToken).toHaveBeenCalledWith('decrypted-refresh-token');
	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(1);
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'rejected', true, 'access-token', undefined);
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect((await commentRow('c1'))?.status).toBe('rejected');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'ban', reason: 'manual review', actor: 'user' });
});

test('load surfaces the real hold state per queued comment', async () => {
	await seedComment('c-held', 'UC1', 'pending');
	await seedHold('c-held', 'UC1', 'completed');
	await seedComment('c-requested', 'UC1', 'pending');
	await seedHold('c-requested', 'UC1', 'dispatched');
	await seedComment('c-none', 'UC1', 'pending');

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);

	expect(result?.pending.map((row) => `${row.id}:${row.holdState ?? 'none'}`).sort()).toEqual([
		'c-held:completed',
		'c-none:none',
		'c-requested:dispatched'
	]);
});

test('load returns only this channel’s pending comments', async () => {
	await seedComment('c-pending', 'UC1', 'pending');
	await seedComment('c-approved', 'UC1', 'approved');
	await seedComment('c-other', 'UC2', 'pending');

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);

	expect(result?.pending.map((row) => row.id)).toEqual(['c-pending']);
});

test('act fails loudly on a channel owned by another team and changes nothing', async () => {
	// The caller personally connected UC1 — under a different team. The org
	// gate must still 404 it (a per-user check would wrongly pass here).
	await testDb().db.update(channels).set({ orgId: 'org-2' }).where(eq(channels.id, 'UC1'));
	await seedComment('c9', 'UC1');
	for (const name of actionNames) {
		await expect(act(name, { commentId: 'c9' })).rejects.toThrowError(expect.objectContaining({ status: 404 }));
	}
	await expectNothingDecided('c9', 'pending');
});

test('act rejects a signed-out request with 401', async () => {
	await seedComment('c8', 'UC1');
	for (const name of actionNames) {
		await expect(act(name, { commentId: 'c8' }, 'UC1', null)).rejects.toThrowError(expect.objectContaining({ status: 401 }));
	}
	await expectNothingDecided('c8', 'pending');
});
