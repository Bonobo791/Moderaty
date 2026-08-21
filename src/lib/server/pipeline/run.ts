// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; see LICENSE.

import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { decrypt } from '$lib/server/crypto';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { DeadlineExceededError } from '$lib/server/http';
import { resolveOpenAiKey } from '$lib/server/openaiKey';
import { fetchNewComments, refreshAccessToken, type CommentPage } from '$lib/server/youtube';
import { assertChannelActive, ChannelDeactivatedError, runEnforcement } from './enforcement';
import { decideNewComments } from './scoring';
import { stageOrAuditDecisions } from './staging';
import type { ChannelRunResult, RunChannelOptions } from './types';

/**
 * Creates an empty channel run result with no processed comments or actions.
 *
 * @returns A zero-count result indicating that the channel was skipped
 */
function emptyResult(): ChannelRunResult {
	return { fetched: 0, acted: 0, queued: 0, partial: false, skipped: true, dryRun: false };
}

/**
 * Persists moderation decisions and their associated comments, actions, and audit records.
 *
 * @param channelId - The channel whose comments are being staged
 * @param decisions - Moderation decisions to persist
 * @param orgId - Organization whose credits are charged for staged comments
 */
async function persistResults(
	channelId: string,
	channel: typeof channels.$inferSelect,
	page: CommentPage
) {
	// Compare instants, not strings: timestamps may carry different UTC offsets,
	// so lexicographic order can select an older comment and move the cursor back.
	const newest = page.comments.reduce<string | null>(
		(best, comment) =>
			best === null || Date.parse(comment.publishedAt) > Date.parse(best)
				? comment.publishedAt
				: best,
		null
	) ?? channel.cursor;
	const scanCursor = channel.scanCursor ?? newest;
	const complete = page.reachedCursor || !page.nextPageToken;
	await db
		.update(channels)
		.set(
			complete
				? { cursor: scanCursor, nextPageToken: null, scanCursor: null }
				: { nextPageToken: page.nextPageToken, scanCursor }
		)
		.where(eq(channels.id, channelId));
}

/** Window-mode dry-run finish: reported, never persisted (I8 — the caller owns the drain state). */
function finishDryRun(
	window: RunChannelOptions['window'],
	page: CommentPage,
	{ fetched, acted, queued }: { fetched: number; acted: number; queued: number }
): ChannelRunResult {
	const windowState = window
		? {
				windowComplete: page.reachedCursor || !page.nextPageToken,
				windowNextPageToken: page.reachedCursor ? null : page.nextPageToken
			}
		: {};
	return { fetched, acted, queued, partial: false, skipped: false, dryRun: true, ...windowState };
}

/**
 * Applies outstanding YouTube actions and triggers the auto top-up (best-effort
 * — a payment failure never fails the moderation run; the daily cron sweep is
 * the backstop). Returns outOfCredits when AI was deferred by an empty balance,
 * which parks the cursor so the same comments re-fetch after a top-up.
 */
/**
 * Loads and validates a channel for a run: not-found and invalid DRY_RUN throw
 * loudly; an inactive channel is a skip (empty result); window mode requires
 * dry-run semantics (the rescore skips the stored-IDs dedupe, so a live window
 * run would stage duplicates and re-enforce).
 */
async function loadChannelForRun(
	channelId: string,
	forceDryRun: boolean | undefined,
	window: RunChannelOptions['window']
): Promise<{ kind: 'run'; channel: typeof channels.$inferSelect; dryRun: boolean } | { kind: 'skip'; result: ChannelRunResult }> {
	const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();
	if (!channel) throw new Error(`channel not found: ${channelId}`);
	if (!channel.active) return { kind: 'skip', result: emptyResult() };
	if (env.DRY_RUN !== 'true' && env.DRY_RUN !== 'false') {
		throw new Error('DRY_RUN must be true or false');
	}
	const dryRun = forceDryRun === true || env.DRY_RUN === 'true';
	if (window && !dryRun) throw new Error('window mode requires dry-run semantics (pass forceDryRun)');
	return { kind: 'run', channel, dryRun };
}

/**
 * Runs moderation for newly fetched comments on a channel.
 *
 * @param channelId - The channel to moderate
 * @param maxPages - Maximum number of comment pages to process
 * @param deadline - Optional execution deadline
 * @returns Counts and execution state, including whether the run was partial, simulated, skipped, or stopped by insufficient credits
 * @throws When the channel or dry-run configuration is invalid, or when comment processing or staging fails
 */
export async function runChannel(
	channelId: string,
	{ maxPages = 3, deadline, forceDryRun, window }: RunChannelOptions = {}
): Promise<ChannelRunResult> {
	let fetched = 0;
	let acted = 0;
	let queued = 0;
	// Stryker disable next-line BooleanLiteral: equivalent — dryRun is reassigned from env/forceDryRun before any read; the catch only returns for errors thrown after that assignment
	let dryRun = false;
	try {
		const loaded = await loadChannelForRun(channelId, forceDryRun, window);
		if (loaded.kind === 'skip') return loaded.result;
		const { channel } = loaded;
		dryRun = loaded.dryRun;
		const accessToken = await refreshAccessToken(decrypt(channel.refreshTokenEnc), deadline);
		// Window mode (on-demand dry-run drain): one page bounded by the window,
		// independent of the live cursor/checkpoint — real runs keep advancing
		// those undisturbed.
		const page = await fetchNewComments(channelId, accessToken, window ? window.boundary : channel.cursor, {
			maxPages: window ? 1 : maxPages,
			pageToken: window ? window.pageToken : channel.nextPageToken,
			deadline
		});
		fetched = page.comments.length;

		const { decisions, failures, deferred } = await decideNewComments(channelId, page, {
			accessToken,
			toneLevel: channel.toneLevel ?? 1,
			protections: {
				protectLgbtqia: channel.protectLgbtqia ?? 0,
				protectWomen: channel.protectWomen ?? 0
			},
			// Per-org BYOK (hosted plans): the org's own OpenAI key when stored,
			// the deployment's env key otherwise (openaiKey.ts).
			openAiKey: await resolveOpenAiKey(channel.orgId),
			deadline,
			rescore: window !== undefined,
			orgId: channel.orgId,
			// Live runs consume credits (and gate AI on them); dry runs never do.
			consumeCredits: !dryRun
		});
		queued = decisions.filter((decision) => decision.auditAction === 'queue').length;

		// Deletion may have committed during the YouTube/AI calls above: re-check
		// before any durable write (I3) so a deleted account gets no new rows.
		await assertChannelActive(channelId);
		acted = await stageOrAuditDecisions(channelId, decisions, dryRun, channel.orgId);
		// Fail loudly only after successful decisions are staged, and before the
		// cursor advances, so the next run retries just the failed comments.
		if (failures.length) {
			throw new Error(`moderation decision failed for ${failures.length} comment(s): ${failures.join('; ')}`);
		}
		if (dryRun) {
			return finishDryRun(window, page, { fetched, acted, queued });
		}

		const enforcement = await runEnforcement(channelId, accessToken, deadline, channel.orgId, deferred);
		acted = enforcement.acted;
		if (enforcement.outOfCredits) {
			return { fetched, acted, queued, partial: false, skipped: false, dryRun, outOfCredits: true };
		}
		await persistResults(channelId, channel, page);
		return { fetched, acted, queued, partial: false, skipped: false, dryRun };
	} catch (error) {
		if (error instanceof DeadlineExceededError) {
			return { fetched, acted, queued, partial: true, skipped: false, dryRun };
		}
		if (error instanceof ChannelDeactivatedError) {
			console.info(`stopping run for ${channelId}: ${error.message}`);
			return { fetched, acted, queued, partial: true, skipped: false, dryRun };
		}
		throw error;
	}
}
