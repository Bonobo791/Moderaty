import { and, eq, isNull } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { decrypt } from '$lib/server/crypto';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { DeadlineExceededError } from '$lib/server/http';
import { channelMatchesClaim } from '$lib/server/dryRun';
import { resolveOpenAiKey } from '$lib/server/openaiKey';
import { TONE_LEVEL_OMNI_ONLY } from '$lib/toneLevels';
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
	const cursor = complete ? scanCursor : channel.cursor;
	await db.transaction(async (transaction) => {
		await assertChannelActive(channelId, transaction, channel);
		// The checkpoint write carries THIS run's scan identity: a replant
		// mid-run (owner re-requested the window — fresh boundary+nonce) must
		// not be cleared or advanced by a stale worker. The scan predicates
		// make its update a no-op, and the 0-row check aborts loudly the same
		// way the feedback-history checkpoint guard does (codeant).
		const updated = await transaction
			.update(channels)
			.set(
				complete
					? { cursor: scanCursor, nextPageToken: null, scanCursor: null, historyBoundary: null, historyScanId: null }
					: { nextPageToken: page.nextPageToken, scanCursor }
				)
			.where(
				and(
					eq(channels.id, channelId),
					channel.historyScanId === null
						? isNull(channels.historyScanId)
						: eq(channels.historyScanId, channel.historyScanId),
					channel.historyBoundary === null
						? isNull(channels.historyBoundary)
						: eq(channels.historyBoundary, channel.historyBoundary)
				)
			)
			.returning({ id: channels.id });
		if (!updated.length) throw new Error(`history checkpoint changed for channel ${channelId} — aborting checkpoint write`);
	});
	return { complete, cursor };
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
	window: RunChannelOptions['window'],
	claim?: RunChannelOptions['claim']
): Promise<{ kind: 'run'; channel: typeof channels.$inferSelect; dryRun: boolean } | { kind: 'skip'; result: ChannelRunResult }> {
	const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();
	if (!channel) throw new Error(`channel not found: ${channelId}`);
	// A claimed preview must run against the row that claimed it: a
	// delete/reconnect can swap in a fresh row under the same id between the
	// claim and this load, and the row-identity guard inside the run would
	// only ever compare the new row to itself (cubic+codeant).
	if (claim && !channelMatchesClaim(channel, claim)) {
		throw new Error(`channel ${channelId} changed under the dry-run claim — aborting the preview`);
	}
	if (!channel.active) {
		console.info(`run ${channelId}: skipped — channel inactive`);
		return { kind: 'skip', result: emptyResult() };
	}
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
/**
 * Score the fetched page and stage the resulting decisions (or audit them on
 * a dry run). Throwing on scoring failures happens only AFTER successful
 * decisions are staged and BEFORE the cursor advances, so the next run
 * retries just the failed comments.
 */
const decideAndStage = async (
	channelId: string,
	page: CommentPage,
	fetched: number,
	ctx: {
		channel: typeof channels.$inferSelect;
		accessToken: string;
		deadline?: number;
		dryRun: boolean;
		window: RunChannelOptions['window'];
		rescan: { chargeScope: string | null; scanStamp: string } | undefined;
	}
): Promise<{ acted: number; queued: number; skipped: number; deferred: number; stagedCount: number }> => {
	const { channel, accessToken, deadline, dryRun, window, rescan } = ctx;
	const { decisions, failures, deferred, protectedIds, protection } = await decideNewComments(channelId, page, {
		accessToken,
		toneLevel: channel.toneLevel ?? TONE_LEVEL_OMNI_ONLY,
		protections: {
			protectLgbtqia: channel.protectLgbtqia ?? 0,
			protectWomen: channel.protectWomen ?? 0
		},
		// Per-org BYOK (lifetime plan): the org's own OpenAI key when
		// stored, the deployment's env key for metered plans only — a
		// lifetime org without one resolves undefined and the comments
		// queue unscored (I11; openaiKey.ts).
		openAiKey: await resolveOpenAiKey(channel.orgId),
		deadline,
		// Rescore every fetched comment, skipping the stored-IDs dedupe:
		// dry-run windows by design, and user-requested history rescans —
		// the planted historyBoundary means the owner asked to re-analyze
		// the window, so stored comments get a fresh decision (their rows
		// upsert) instead of being skipped.
		rescore: window !== undefined || channel.historyBoundary !== null,
		orgId: channel.orgId,
		// The rescan's staging marker lets the scorer skip comments this
		// scan already committed instead of re-scoring them on a parked
		// page or a crash retry — billing-independent (codex).
		scanStamp: rescan?.scanStamp,
		// Live runs consume credits (and gate AI on them); dry runs never do.
		consumeCredits: !dryRun
	});

	// Deletion may have committed during the YouTube/AI calls above: re-check
	// before any durable write (I3) so a deleted account gets no new rows.
	await assertChannelActive(channelId, db, channel);
	const { acted, queued, stagedCount } = await stageOrAuditDecisions(channelId, decisions, dryRun, { orgId: channel.orgId, expected: channel, rescan, protectedIds, protection, accessToken, deadline });
	// Fail loudly only after successful decisions are staged, and before the
	// cursor advances, so the next run retries just the failed comments.
	if (failures.length) {
		throw new Error(`moderation decision failed for ${failures.length} comment(s): ${failures.join('; ')}`);
	}
	return { acted, queued, skipped: fetched - stagedCount - failures.length - deferred, deferred, stagedCount };
};

export async function runChannel(
	channelId: string,
	{ maxPages = 3, deadline, forceDryRun, window, claim }: RunChannelOptions = {}
): Promise<ChannelRunResult> {
	let fetched = 0;
	let acted = 0;
	let queued = 0;
	// Stryker disable next-line BooleanLiteral: equivalent — dryRun is reassigned from env/forceDryRun before any read; the catch only returns for errors thrown after that assignment
	let dryRun = false;
	try {
		const loaded = await loadChannelForRun(channelId, forceDryRun, window, claim);
		if (loaded.kind === 'skip') return loaded.result;
		const { channel } = loaded;
		dryRun = loaded.dryRun;
		await assertChannelActive(channelId, db, channel);
		const accessToken = await refreshAccessToken(decrypt(channel.refreshTokenEnc), deadline);
		await assertChannelActive(channelId, db, channel);
		// Window mode (on-demand dry-run drain): one page bounded by the window,
		// independent of the live cursor/checkpoint — real runs keep advancing
		// those undisturbed.
		const page = await fetchNewComments(channelId, accessToken, window ? window.boundary : channel.cursor, {
			maxPages: window ? 1 : maxPages,
			pageToken: window ? window.pageToken : channel.nextPageToken,
			deadline
		});
		fetched = page.comments.length;

		// A planted rescan upserts stored rows and scopes its charge anchors to
		// the per-request nonce: each requested scan debits once while a retry
		// of the SAME scan stages covered. A null scan id is a drain planted
		// before the nonce column existed — it still upserts, but keeps the
		// plain comment-id anchors its earlier pages already minted (codex).
		// The scan stamp the upsert writes to comments.scan_id falls back to
		// the boundary for those pre-nonce drains: the boundary is a stable
		// per-drain identity and the column has no pre-existing values to
		// collide with, so every drain — nonce or legacy — marks its own
		// staged rows for the parked-page/crash-retry skip (codex).
		const rescan =
			channel.historyBoundary === null
				? undefined
				: {
						chargeScope: channel.historyScanId,
						scanStamp: channel.historyScanId ?? channel.historyBoundary
					};

		const staged = await decideAndStage(channelId, page, fetched, { channel, accessToken, deadline, dryRun, window, rescan });
		const { skipped, deferred } = staged;
		acted = staged.acted;
		queued = staged.queued;
		if (dryRun) {
			console.info(`run ${channelId}: dry run — fetched=${fetched} skippedAlreadySeen=${skipped} rescan=${rescan !== undefined} audited=${acted}`);
			return finishDryRun(window, page, { fetched, acted, queued });
		}

		const enforcement = await runEnforcement(channelId, accessToken, deadline, channel.orgId, deferred, channel);
		acted = enforcement.acted;
		if (enforcement.outOfCredits) {
			console.warn(
				`run ${channelId}: out of credits — ${deferred} comment(s) deferred, cursor parked; fetched=${fetched} skippedAlreadySeen=${skipped} rescan=${rescan !== undefined}`
			);
			return { fetched, acted, queued, partial: false, skipped: false, dryRun, outOfCredits: true };
		}
		const { complete, cursor: newCursor } = await persistResults(channelId, channel, page);
		console.info(
			`run ${channelId}: fetched=${fetched} skippedAlreadySeen=${skipped} staged=${staged.stagedCount} deferred=${deferred} acted=${acted} queued=${queued} rescan=${rescan !== undefined}; scan ${complete ? `complete — cursor now ${newCursor}` : `continues next run (boundary ${channel.cursor})`}`
		);
		return { fetched, acted, queued, partial: false, skipped: false, dryRun };
	} catch (error) {
		if (error instanceof DeadlineExceededError) {
			console.warn(`run ${channelId}: deadline reached — partial (fetched=${fetched})`);
			return { fetched, acted, queued, partial: true, skipped: false, dryRun, stoppedReason: 'deadline' };
		}
		if (error instanceof ChannelDeactivatedError) {
			console.info(`stopping run for ${channelId}: ${error.message}`);
			return { fetched, acted, queued, partial: true, skipped: false, dryRun, stoppedReason: 'deactivated' };
		}
		throw error;
	}
}
