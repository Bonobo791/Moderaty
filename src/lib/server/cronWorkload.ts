import { and, asc, eq, gte, isNull, lt, or } from 'drizzle-orm';
import { db, withBusyRetry } from './db';
import { channels, cronWorkloadState, feedbackDigests } from './db/schema';

const LEASE_MS = 10 * 60 * 1000;
// Current schedules tick every minute. The documented optional */15 schedule
// needs two slots (preview → live → preview) plus a five-minute margin for a
// deadline-aborted preview to get a retry. Queue age is never a stale signal.
export const PREVIEW_PENDING_STALE_MS = 35 * 60 * 1000;

type Channel = typeof channels.$inferSelect;
type Claim = { channel: Channel; leaseExpiresAt: string; nowIso: string };
export type CronWorkload =
	| (Claim & { kind: 'preview'; digest: typeof feedbackDigests.$inferSelect })
	| (Claim & { kind: 'live' })
	| { kind: 'none' }
	| { kind: 'budget-exhausted' }
	| { kind: 'claim-lost'; channelId: string };

/** Select, lease and advance the shared turn in one short write transaction.
 * No provider work happens under the DB lock. A crash after commit still
 * yields the next class its turn; failed/rolled-back claims never spend one.
 */
export async function claimCronWorkload(deadline: number): Promise<CronWorkload> {
	return withBusyRetry(() => db.transaction(async (tx): Promise<CronWorkload> => {
		if (Date.now() >= deadline) return { kind: 'budget-exhausted' };
		await tx.insert(cronWorkloadState).values({ id: 1 }).onConflictDoNothing();
		const state = await tx.select().from(cronWorkloadState).where(eq(cronWorkloadState.id, 1)).get();
		if (!state) throw new Error('cron: scheduler turn is missing');
		const now = Date.now();
		const nowIso = new Date(now).toISOString();
		const staleBefore = new Date(now - PREVIEW_PENDING_STALE_MS).toISOString();
		const claimable = and(eq(channels.active, 1), or(isNull(channels.leaseExpiresAt), lt(channels.leaseExpiresAt, nowIso)));
		const preview = await tx.select({ digest: feedbackDigests, channel: channels })
			.from(feedbackDigests).innerJoin(channels, eq(feedbackDigests.channelId, channels.id))
			.where(and(eq(feedbackDigests.status, 'dry-run-pending'), claimable,
				or(isNull(feedbackDigests.attemptedAt), gte(feedbackDigests.attemptedAt, staleBefore))))
			.orderBy(asc(feedbackDigests.id)).limit(1).get();
		const live = await tx.select().from(channels).where(claimable)
			.orderBy(asc(channels.lastRunAt), asc(channels.id)).limit(1).get();
		if (!preview && !live) return { kind: 'none' };
		const kind = preview && (!live || state.nextWorkload === 'preview') ? 'preview' : 'live';
		const channel = kind === 'preview' ? preview!.channel : live!;
		if (Date.now() >= deadline) return { kind: 'budget-exhausted' };
		const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
		const claimed = await tx.update(channels).set({ leaseExpiresAt })
			.where(and(eq(channels.id, channel.id), claimable)).returning({ id: channels.id });
		if (!claimed.length) return { kind: 'claim-lost', channelId: channel.id };
		if (kind === 'preview' && !preview!.digest.attemptedAt) {
			await tx.update(feedbackDigests).set({ attemptedAt: nowIso })
				.where(eq(feedbackDigests.id, preview!.digest.id));
		}
		// Preserve the waiting class's turn when only one class has work.
		if (preview && live) {
			await tx.update(cronWorkloadState).set({ nextWorkload: kind === 'preview' ? 'live' : 'preview' })
				.where(eq(cronWorkloadState.id, 1));
		}
		const claim = { channel, leaseExpiresAt, nowIso };
		return kind === 'preview' ? { ...claim, kind, digest: preview!.digest } : { ...claim, kind };
	}));
}

/** Release only this claimant's lease; a later owner is never disturbed. */
export async function releaseCronWorkload(claim: Claim): Promise<void> {
	await db.update(channels).set({ leaseExpiresAt: null })
		.where(and(eq(channels.id, claim.channel.id), eq(channels.leaseExpiresAt, claim.leaseExpiresAt)));
}
