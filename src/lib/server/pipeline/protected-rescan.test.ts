import { beforeEach, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, comments, creditTransactions, organizations } from '$lib/server/db/schema';
import type { NewComment } from '$lib/server/youtube';

const model = vi.hoisted(() => ({ scoreComment: vi.fn(), scoreTone: vi.fn(), detectJailbreak: vi.fn(), fetchVideoMetadata: vi.fn(), fetchAuthorHandles: vi.fn() }));
vi.mock('$lib/server/moderation', () => ({ scoreComment: model.scoreComment, serializeScores: () => '{}' }));
vi.mock('$lib/server/tone', () => ({ scoreTone: model.scoreTone }));
vi.mock('$lib/server/jailbreak', () => ({ detectJailbreak: model.detectJailbreak }));
vi.mock('$lib/server/youtube', async (original) => ({ ...await original<typeof import('$lib/server/youtube')>(), fetchVideoMetadata: model.fetchVideoMetadata, fetchAuthorHandles:model.fetchAuthorHandles }));
import { decideNewComments } from './scoring';
import { stageDecisions, stageOrAuditDecisions } from './staging';

setupTestDb(['channels', 'comments', 'rules', 'channel_allowed_handles', 'organizations', 'credit_transactions', 'audit_log', 'moderation_actions', 'stripe_subscription_periods']);
beforeEach(async () => {
	vi.resetAllMocks();
	model.scoreComment.mockResolvedValue({ score: 0.1, scores: {} });
	model.scoreTone.mockResolvedValue({ score: 0 });
	model.detectJailbreak.mockResolvedValue({ flagged: false, confidence: 0.1 });
	model.fetchVideoMetadata.mockResolvedValue(new Map());
	model.fetchAuthorHandles.mockResolvedValue(new Map());
	await testDb().db.insert(organizations).values({ id: 'org', name: 'Org', creditsRemaining: 1 });
	await testDb().db.insert(channels).values({ id: 'channel', userId: 'owner', orgId: 'org', title: 'Channel', refreshTokenEnc: 'enc' });
});
const comment = (id: string): NewComment => ({ id, threadId: id, videoId: `video-${id}`, authorChannelId: 'author', authorName: 'Author', text: id, publishedAt: '2026-01-01T00:00:00Z' });
const options = { accessToken: 'access', toneLevel: 2, protections: {}, openAiKey: 'key', rescore: true, consumeCredits: true, orgId: 'org', scanStamp: 'scan' };
function protectedClaim(claim: string): Pick<typeof comments.$inferInsert, 'status' | 'humanDispatchToken' | 'humanDispatchState'> {
	let humanDispatchState: 'in_flight' | 'uncertain' | null = null;
	if (claim !== 'restoring') humanDispatchState = claim === 'in_flight' ? 'in_flight' : 'uncertain';
	return { status: claim === 'restoring' ? 'restoring' : 'rejected', humanDispatchToken: claim === 'restoring' || claim === 'state-only' ? null : 'owner-token', humanDispatchState };
}

test.each(['restoring', 'in_flight', 'uncertain', 'state-only'])('a one-credit rescan excludes a %s claim before enrichment and AI budget consumption', async (claim) => {
	await testDb().db.insert(comments).values({ id: 'protected', channelId: 'channel', text: 'protected', publishedAt: comment('protected').publishedAt, decidedBy: 'human', ...protectedClaim(claim) });
	const batch = await decideNewComments('channel', { comments: [comment('protected'), comment('eligible')], nextPageToken: null, reachedCursor: true }, options);
	expect(batch.deferred).toBe(0);
	expect(batch.decisions.map(decision => decision.comment.id)).toEqual(['eligible']);
	expect(model.fetchVideoMetadata).toHaveBeenCalledExactlyOnceWith(['video-eligible'], 'access', undefined);
	expect(model.scoreComment).toHaveBeenCalledExactlyOnceWith('eligible', undefined, 'key');
	await stageDecisions('channel', batch.decisions, { orgId: 'org', protectedIds: batch.protectedIds, rescan: { scanStamp: 'scan', chargeScope: 'scan' } });
	expect((await testDb().db.select().from(organizations).get())?.creditsRemaining).toBe(0);
	expect(await testDb().db.select().from(creditTransactions)).toHaveLength(1);
	expect(await testDb().db.select().from(comments).where(eq(comments.id, 'protected')).get()).toMatchObject({ ...protectedClaim(claim), decidedBy: 'human' });
});

async function seedProtected() {
	await testDb().db.insert(comments).values({ id: 'protected', channelId: 'channel', text: 'protected', publishedAt: comment('protected').publishedAt, decidedBy: 'human', ...protectedClaim('uncertain') });
}
const protectedPage = () => ({ comments: [comment('protected')], nextPageToken: null, reachedCursor: true });
const stageBatch = (batch: Awaited<ReturnType<typeof decideNewComments>>) => stageDecisions('channel', batch.decisions, { orgId: 'org', protectedIds: batch.protectedIds, rescan: { scanStamp: 'scan', chargeScope: 'scan' } });

test('an all-protected page is stamped without scoring or billing and stays skipped after settlement', async () => {
	await seedProtected();
	const batch = await decideNewComments('channel', protectedPage(), options);
	expect(batch.protectedIds).toEqual(['protected']);
	expect(await stageBatch(batch)).toEqual({ acted: 0, queued: 0, stagedCount: 0 });
	expect(await testDb().db.select().from(comments).get()).toMatchObject({ scanId: 'scan', ...protectedClaim('uncertain') });
	await testDb().db.update(comments).set({ humanDispatchToken: null, humanDispatchState: null });
	expect((await decideNewComments('channel', protectedPage(), options)).decisions).toEqual([]);
	expect(model.fetchVideoMetadata).not.toHaveBeenCalled();
	expect(model.scoreComment).not.toHaveBeenCalled();
	expect(model.detectJailbreak).not.toHaveBeenCalled();
	expect(await testDb().db.select().from(creditTransactions)).toEqual([]);
	expect(await testDb().db.select().from(auditLog)).toEqual([]);
	expect((await testDb().db.select().from(organizations).get())?.creditsRemaining).toBe(1);
});

test('a claim released before the staging transaction receives no protected scan stamp', async () => {
	await seedProtected();
	const batch = await decideNewComments('channel', protectedPage(), options);
	await testDb().db.update(comments).set({ humanDispatchToken: null, humanDispatchState: null });
	await stageBatch(batch);
	expect(await testDb().db.select().from(comments).get()).toMatchObject({ status: 'rejected', scanId: null, humanDispatchToken: null, humanDispatchState: null });
});

test('connector detachment prevents even an all-protected scan stamp', async () => {
	await seedProtected();
	const batch = await decideNewComments('channel', protectedPage(), options);
	await testDb().db.update(channels).set({ userId: 'new-owner', refreshTokenEnc: 'new-grant' });
	await expect(stageDecisions('channel', batch.decisions, { protectedIds: batch.protectedIds, expected: { userId: 'owner', refreshTokenEnc: 'enc' }, rescan: { scanStamp: 'scan' } })).rejects.toThrow(/deactivated/);
	expect((await testDb().db.select().from(comments).get())?.scanId).toBeNull();
});

test('a human claim begun during scoring is preserved by the transactional guard without charge or audit', async () => {
	await testDb().db.insert(comments).values({ id: 'protected', channelId: 'channel', text: 'protected', publishedAt: comment('protected').publishedAt, status: 'approved', decidedBy: 'ai' });
	model.scoreComment.mockImplementationOnce(async () => {
		await testDb().db.update(comments).set({ status: 'restoring', restoreIntentId: 17 });
		return { score: 0.1, scores: {} };
	});
	const batch = await decideNewComments('channel', protectedPage(), options);
	expect(batch.protectedIds).toEqual([]);
	expect(batch.decisions).toHaveLength(1);
	expect(await stageBatch(batch)).toEqual({ acted: 0, queued: 0, stagedCount: 0 });
	expect(await testDb().db.select().from(comments).get()).toMatchObject({ status: 'restoring', restoreIntentId: 17, scanId: 'scan' });
	expect(await testDb().db.select().from(creditTransactions)).toEqual([]);
	expect(await testDb().db.select().from(auditLog)).toEqual([]);
});

test('a dry-run preview still scores protected comments and leaves durable rows and credits unchanged', async () => {
	await seedProtected();
	const before = await testDb().db.select().from(comments).get();
	const batch = await decideNewComments('channel', protectedPage(), { ...options, consumeCredits: false });
	expect(batch.decisions).toHaveLength(1);
	expect(batch.protectedIds).toEqual([]);
	await stageOrAuditDecisions('channel', batch.decisions, true, { orgId: 'org' });
	expect(model.scoreComment).toHaveBeenCalledOnce();
	expect(await testDb().db.select().from(comments).get()).toEqual(before);
	expect((await testDb().db.select().from(organizations).get())?.creditsRemaining).toBe(1);
	expect(await testDb().db.select().from(creditTransactions)).toEqual([]);
	expect(await testDb().db.select().from(auditLog)).toEqual([expect.objectContaining({ action: 'dry-run' })]);
});
