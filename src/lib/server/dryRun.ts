import { and, eq, isNull, lt, or } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';

export type PreviewFeature = 'moderation' | 'feedback';

export async function claimDryRun(
	channelId: string,
	orgId: string,
	feature: PreviewFeature
): Promise<{ lease: string } | { status: 404 | 409; error: string }> {
	const now = new Date().toISOString();
	const lease = new Date(Date.now() + 60_000).toISOString();
	const usedColumn = feature === 'moderation' ? channels.moderationDryRunUsedAt : channels.feedbackDryRunUsedAt;
	const claimed = await db
		.update(channels)
		.set(
			feature === 'moderation'
				? { leaseExpiresAt: lease, moderationDryRunUsedAt: now }
				: { leaseExpiresAt: lease, feedbackDryRunUsedAt: now }
		)
		.where(
			and(
				eq(channels.id, channelId),
				eq(channels.orgId, orgId),
				eq(channels.active, 1),
				isNull(usedColumn),
				or(isNull(channels.leaseExpiresAt), lt(channels.leaseExpiresAt, now))
			)
		)
		.returning({ id: channels.id });
	if (claimed.length) return { lease };

	const channel = await db
		.select({ active: channels.active, used: usedColumn })
		.from(channels)
		.where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)))
		.get();
	if (!channel) return denial(404, channelId, feature, 'channel not found');
	if (channel.used) {
		return denial(409, channelId, feature, `Limited to 1 free ${feature} dry run per channel. This channel has already used it.`);
	}
	if (channel.active !== 1) return denial(409, channelId, feature, 'This channel is paused. Resume it before running a dry run.');
	return denial(409, channelId, feature, 'This channel is busy. Retry in a minute.');
}

function denial(status: 404 | 409, channelId: string, feature: PreviewFeature, error: string) {
	console.warn('dry-run claim denied:', { channelId, feature, status });
	return { status, error } as const;
}
