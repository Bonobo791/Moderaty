import { and, eq, isNull, notExists, type SQL } from 'drizzle-orm';

import { decrypt } from '$lib/server/crypto';
import { db } from '$lib/server/db';
import { channels, comments, feedbackHistoryComments } from '$lib/server/db/schema';
import type { LedgerHandle } from '$lib/server/billing/ledger';
import { fetchNewComments, refreshAccessToken } from '$lib/server/youtube';

export interface FeedbackComment {
	id: string;
	text: string;
	publishedAt: string;
}

export interface FeedbackHistoryPage {
	batch: FeedbackComment[];
	nextPageToken: string | null;
	complete: boolean;
}

export async function fetchFeedbackPage(
	channel: typeof channels.$inferSelect,
	boundary: string,
	pageToken: string | null,
	deadline?: number
): Promise<FeedbackHistoryPage> {
	const accessToken = await refreshAccessToken(decrypt(channel.refreshTokenEnc), deadline);
	const page = await fetchNewComments(channel.id, accessToken, boundary, { maxPages: 1, pageToken, deadline });
	if (page.comments.length > 100) throw new Error(`feedback history page exceeded 100 comments for channel ${channel.id}`);
	const unique = new Map<string, FeedbackComment>();
	for (const comment of page.comments) {
		if (!unique.has(comment.id)) unique.set(comment.id, { id: comment.id, text: comment.text.slice(0, 500), publishedAt: comment.publishedAt });
	}
	const batch = [...unique.values()].sort(
		(a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || a.id.localeCompare(b.id)
	);
	return {
		batch,
		nextPageToken: page.reachedCursor ? null : page.nextPageToken,
		complete: page.reachedCursor || !page.nextPageToken
	};
}

export function pendingStoredFeedback(channelId: string): SQL {
	return and(
		eq(comments.channelId, channelId),
		isNull(comments.feedbackDigestedAt),
		notExists(
			db
				.select({ id: feedbackHistoryComments.id })
				.from(feedbackHistoryComments)
				.where(and(eq(feedbackHistoryComments.channelId, channelId), eq(feedbackHistoryComments.id, comments.id)))
		)
	)!;
}

export async function advanceFeedbackHistory(
	tx: LedgerHandle,
	channel: typeof channels.$inferSelect,
	page: FeedbackHistoryPage
): Promise<void> {
	if (!channel.feedbackHistoryBoundary) throw new Error(`channel ${channel.id} has no feedback history boundary`);
	const updated = await tx
		.update(channels)
		.set(
			page.complete
				? { feedbackHistoryBoundary: null, feedbackHistoryPageToken: null, feedbackHistoryScanId: null }
				: { feedbackHistoryBoundary: channel.feedbackHistoryBoundary, feedbackHistoryPageToken: page.nextPageToken }
		)
		.where(
			and(
				eq(channels.id, channel.id),
				eq(channels.active, 1),
				eq(channels.feedbackEnabled, 1),
				channel.orgId === null ? isNull(channels.orgId) : eq(channels.orgId, channel.orgId),
				channel.leaseExpiresAt === null ? isNull(channels.leaseExpiresAt) : eq(channels.leaseExpiresAt, channel.leaseExpiresAt),
				eq(channels.feedbackHistoryBoundary, channel.feedbackHistoryBoundary),
				channel.feedbackHistoryPageToken === null
					? isNull(channels.feedbackHistoryPageToken)
					: eq(channels.feedbackHistoryPageToken, channel.feedbackHistoryPageToken),
				// The scan nonce is the checkpoint's identity: a replanted scan of
				// the SAME window can share boundary and page token with a stale
				// worker — only the scan id distinguishes them (codeant).
				channel.feedbackHistoryScanId === null
					? isNull(channels.feedbackHistoryScanId)
					: eq(channels.feedbackHistoryScanId, channel.feedbackHistoryScanId)
			)
		)
		.returning({ id: channels.id });
	if (!updated.length) throw new Error(`feedback history checkpoint changed for channel ${channel.id} — aborting batch`);
}
