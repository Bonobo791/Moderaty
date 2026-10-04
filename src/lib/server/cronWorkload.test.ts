import { afterEach, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, testDb } from './testdb';
import { channels, cronWorkloadState, feedbackDigests } from './db/schema';
import { claimCronWorkload } from './cronWorkload';
import { seedPendingFeedbackPreview, withTestTrigger } from './cronTestSupport';

setupTestDb(['channels', 'feedback_digests', 'cron_workload_state']);
afterEach(() => vi.restoreAllMocks());

async function seedWork() {
	await testDb().db.insert(channels).values([
		{ id: 'UC-a', title: 'Preview channel', refreshTokenEnc: 'enc' },
		{ id: 'UC-b', title: 'Live channel', refreshTokenEnc: 'enc' }
	]);
	await seedPendingFeedbackPreview('UC-a', { boundary: '2026-01-01T00:00:00.000Z' });
}

async function nextWorkload() {
	return (await testDb().db.select().from(cronWorkloadState).get())?.nextWorkload;
}

async function expectUnclaimed() {
	const rows = await testDb().db.select().from(channels);
	expect(rows.every(row => row.leaseExpiresAt === null)).toBe(true);
	expect((await testDb().db.select().from(feedbackDigests).get())?.attemptedAt).toBeNull();
}

test('concurrent scheduler calls cannot lease the same channel or spend the same contested turn', async () => {
	await seedWork();
	const claims = await Promise.all([
		claimCronWorkload(Date.now() + 20_000), claimCronWorkload(Date.now() + 20_000)
	]);
	expect(claims.map(claim => claim.kind).sort()).toEqual(['live', 'preview']);
	expect(new Set(claims.flatMap(claim => 'channel' in claim ? [claim.channel.id] : [])).size).toBe(2);
	// The preview channel remains leased, so the second claim sees live-only
	// work and preserves the pending live turn instead of blindly toggling.
	expect(await nextWorkload()).toBe('live');
	expect((await claimCronWorkload(Date.now() + 20_000)).kind).toBe('none');
});

test.each([
	{ write: 'turn', table: 'cron_workload_state', message: 'turn unavailable' },
	{ write: 'first-attempt', table: 'feedback_digests', message: 'attempt unavailable' }
])('a failed $write write rolls back the channel lease and first preview attempt without advancing the turn', async ({ table, message }) => {
	await seedWork();
	await withTestTrigger('fail_claim_write', `BEFORE UPDATE ON ${table}
		BEGIN SELECT RAISE(ABORT, '${message}'); END`, async () => {
		await expect(claimCronWorkload(Date.now() + 20_000)).rejects.toMatchObject({ cause: { message: expect.stringContaining(message) } });
		await expectUnclaimed();
		expect(await nextWorkload()).toBeUndefined();
	});
	expect((await claimCronWorkload(Date.now() + 20_000)).kind).toBe('preview');
	expect(await nextWorkload()).toBe('live');
});

test('a zero-row channel claim does not spend the turn or mark the preview attempted', async () => {
	await seedWork();
	await withTestTrigger('lose_claim', `BEFORE UPDATE ON channels
		WHEN NEW.lease_expires_at IS NOT NULL BEGIN SELECT RAISE(IGNORE); END`, async () => {
		expect(await claimCronWorkload(Date.now() + 20_000)).toEqual({ kind: 'claim-lost', channelId: 'UC-a' });
		await expectUnclaimed();
		expect(await nextWorkload()).toBe('preview');
	});
});

test('live-only work remains available while the missing preview class keeps its turn', async () => {
	await seedWork();
	await testDb().db.delete(feedbackDigests);
	const first = await claimCronWorkload(Date.now() + 20_000);
	expect(first.kind).toBe('live');
	expect(await nextWorkload()).toBe('preview');
	await testDb().db.update(channels).set({ leaseExpiresAt: null });
	await seedPendingFeedbackPreview('UC-a', { boundary: '2026-01-01T00:00:00.000Z' });
	expect((await claimCronWorkload(Date.now() + 20_000)).kind).toBe('preview');
});

test('budget exhausted during selection never leases a channel or spends the turn', async () => {
	await seedWork();
	const now = Date.now();
	vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValueOnce(now).mockReturnValue(now + 20_000);
	expect(await claimCronWorkload(now + 20_000)).toEqual({ kind: 'budget-exhausted' });
	await expectUnclaimed();
	expect(await nextWorkload()).toBe('preview');
});

test('a crash after a preview claim leaves the next live turn durable after lease expiry', async () => {
	await seedWork();
	const now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const first = await claimCronWorkload(now + 20_000);
	expect(first.kind).toBe('preview');
	const attemptedAt = (await testDb().db.select().from(feedbackDigests).get())?.attemptedAt;
	clock.mockReturnValue(now + 10 * 60_000 + 1);
	const second = await claimCronWorkload(Date.now() + 20_000);
	expect(second.kind).toBe('live');
	expect(await nextWorkload()).toBe('preview');
	await testDb().db.update(channels).set({ leaseExpiresAt: null }).where(eq(channels.id, 'UC-a'));
	expect((await claimCronWorkload(Date.now() + 20_000)).kind).toBe('preview');
	expect((await testDb().db.select().from(feedbackDigests).get())?.attemptedAt).toBe(attemptedAt);
});

test('releasing an old claim cannot clear a successor lease', async () => {
	await seedWork();
	const { releaseCronWorkload } = await import('./cronWorkload');
	const claim = await claimCronWorkload(Date.now() + 20_000);
	expect(claim.kind).toBe('preview');
	if (!('channel' in claim)) throw new Error('Expected a claimed channel');
	const successorLease = new Date(Date.now() + 20 * 60_000).toISOString();
	await testDb().db.update(channels).set({ leaseExpiresAt: successorLease }).where(eq(channels.id, claim.channel.id));
	await releaseCronWorkload(claim);
	expect((await testDb().db.select().from(channels).where(eq(channels.id, claim.channel.id)).get())?.leaseExpiresAt).toBe(successorLease);
});
