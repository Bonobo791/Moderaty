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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { and, eq, inArray } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { loadHandleSet, normalizeHandle } from '$lib/server/allowlist';
import { consumeCredit, getCredits, orgIsMetered, type LedgerHandle } from '$lib/server/billing/ledger';
import { maybeTriggerAutoTopUp } from '$lib/server/billing/autotopup';
import { decrypt } from '$lib/server/crypto';
import { db } from '$lib/server/db';
import { auditLog, channels, comments, moderationActions, rules } from '$lib/server/db/schema';
import { assertBeforeDeadline, DeadlineExceededError } from '$lib/server/http';
import { scoreComment, serializeScores } from '$lib/server/moderation';
import { resolveOpenAiKey } from '$lib/server/openaiKey';
import { matchPreparedRule, prepareRules, type PreparedRule, type RuleAction } from '$lib/server/rules';
import { scoreTone, type ToneContext, type ToneProtections } from '$lib/server/tone';
import { assertChannelActive, ChannelDeactivatedError, runEnforcement } from './pipeline/enforcement';
import { aiUnavailable, decide } from './pipeline/decisions';
import { stageOrAuditDecisions } from './pipeline/staging';
import type {
	AiOptions,
	ChannelRunResult,
	Decision,
	DecisionBatchOptions,
	OutstandingAction,
	RunChannelOptions,
	ScoreOutcome,
	YoutubeAction
} from './pipeline/types';
export type { ChannelRunResult, RunChannelOptions } from './pipeline/types';

import {
	deleteComment,
	fetchNewComments,
	fetchVideoMetadata,
	getCommentModerationStatus,
	refreshAccessToken,
	setModerationStatus,
	type CommentPage,
	type NewComment
} from '$lib/server/youtube';

/**
 * Creates an empty channel run result with no processed comments or actions.
 *
 * @returns A zero-count result indicating that the channel was skipped
 */
function emptyResult(): ChannelRunResult {
	return { fetched: 0, acted: 0, queued: 0, partial: false, skipped: true, dryRun: false };
}

/**
 * Fetches video titles/descriptions for level-2 tone scoring. Best-effort:
 * a videos.list failure (or missing metadata) scores comments with empty
 * context; the tone pass falling back to the human queue is I11, never a
 * batch abort (DeadlineExceededError still escapes).
 */
async function loadVideoContext(
	toneEnabled: boolean,
	newComments: Array<CommentPage['comments'][number]>,
	accessToken: string,
	deadline: number | undefined
): Promise<{ videoContext: Awaited<ReturnType<typeof fetchVideoMetadata>> | null; metadataError: unknown }> {
	let videoContext: Awaited<ReturnType<typeof fetchVideoMetadata>> | null = null;
	let metadataError: unknown = null;
	if (toneEnabled && newComments.length) {
		videoContext = new Map();
		const videoIds = [...new Set(newComments.map((comment) => comment.videoId).filter((id): id is string => id !== null))];
		if (videoIds.length) {
			try {
				videoContext = await fetchVideoMetadata(videoIds, accessToken, deadline);
			} catch (error) {
				if (error instanceof DeadlineExceededError) throw error;
				metadataError = error;
			}
		}
	}
	return { videoContext, metadataError };
}

async function prepareDecisionBatch(
	channelId: string,
	page: CommentPage,
	options: DecisionBatchOptions
): Promise<{
	newComments: Array<CommentPage['comments'][number]>;
	rulesForChannel: ReturnType<typeof prepareRules>;
	allowlist: Awaited<ReturnType<typeof loadHandleSet>>;
	aiBudget: { remaining: number };
	videoContext: Awaited<ReturnType<typeof fetchVideoMetadata>> | null;
	metadataError: unknown;
}> {
// Credits gate AI scoring for live runs only (I8: a dry run changes nothing
// durable) — and only for METERED orgs. An org that never engaged billing
// (NULL balance, no Stripe customer) is unmetered: self-hosted and
// lifetime-plan orgs score unlimited (the free tier is self-hosted only).
// Consumption for an unmetered org is naturally a no-op (consumeCredit's
// NULL-balance guard rejects the charge), so the gate is the whole story.
// Orphan channels (no org) predate the billing model — they score until
// claimed (infinite budget). The budget is the org's balance: each AI
// decision claims one credit of it, so an org with N credits scores at
// most N AI comments per batch — the rest defer for a post-top-up retry.
let metered = false;
if (options.consumeCredits && options.orgId) {
	metered = await orgIsMetered(options.orgId);
}
const aiBudget = {
	remaining: metered && options.orgId ? await getCredits(options.orgId) : Number.POSITIVE_INFINITY
};
// Dry-run window mode (rescore: true) skips the stored-IDs dedupe entirely:
// re-scoring comments a real run already moderated is the point of the
// preview. The within-batch dedupe below still applies. The DB query is
// skipped in both no-consult cases (rescore, empty page).
// Stryker disable ArrayDeclaration: equivalent — with an empty page there are no comments to consult existingIds for, so its contents are never read
const storedIds =
	!options.rescore && page.comments.length
		? (
				await db
					.select({ id: comments.id })
					.from(comments)
					.where(inArray(comments.id, page.comments.map((comment) => comment.id)))
					.all()
			).map((comment) => comment.id)
		: [];
// Stryker restore ArrayDeclaration
const existingIds = new Set(storedIds);
const rulesForChannel = prepareRules(await db.select().from(rules).where(eq(rules.channelId, channelId)).all());
// One allowlist read per run; decide() checks it before any rule or scoring.
const allowlist = await loadHandleSet(channelId);
// Dedupe twice: against already-stored comments AND within this batch.
// commentThreads pagination can repeat an item across page boundaries, and
// two decisions with one comment id would violate the comments.id PRIMARY
// KEY, failing the entire staging transaction (I1: one bad item never
// aborts the batch).
const seen = new Set<string>();
const newComments = page.comments.filter((comment) => {
	if (existingIds.has(comment.id) || seen.has(comment.id)) return false;
	seen.add(comment.id);
	return true;
});
// A ticked protection flag forces the tone pass on even below level 2: the
// channel owner asked for heightened scrutiny, so the checkbox must never
// be a silent no-op.
const toneEnabled =
	options.toneLevel >= 2 || Boolean(options.protections.protectLgbtqia) || Boolean(options.protections.protectWomen);
const { videoContext, metadataError } = await loadVideoContext(
	toneEnabled,
	newComments,
	options.accessToken,
	options.deadline
);
return { newComments, rulesForChannel, allowlist, aiBudget, videoContext, metadataError };
}
async function scoreComments(
	newComments: Array<CommentPage['comments'][number]>,
	options: {
		rulesForChannel: ReturnType<typeof prepareRules>;
		allowlist: Awaited<ReturnType<typeof loadHandleSet>>;
		aiBudget: { remaining: number };
		videoContext: Awaited<ReturnType<typeof fetchVideoMetadata>> | null;
		metadataError: unknown;
		deadline: number | undefined;
		protections: ToneProtections;
		openAiKey: string | undefined;
	}
): Promise<ScoreOutcome[]> {
	const { rulesForChannel, allowlist, aiBudget, videoContext, metadataError, deadline, protections, openAiKey } = options;
const settled = await Promise.allSettled(
	newComments.map(async (comment) => {
		try {
			if (metadataError) return aiUnavailable(comment, metadataError);
			// Stryker disable next-line ConditionalExpression: equivalent — for a null videoId both branches yield undefined (Map.get(null) misses), and a non-null id takes the false branch anyway
			const meta = comment.videoId === null ? undefined : videoContext?.get(comment.videoId);
			const tone = videoContext
				? { context: { videoTitle: meta?.title ?? '', videoDescription: meta?.description ?? '' } }
				: null;
			return await decide(comment, rulesForChannel, allowlist, tone, aiBudget, { deadline, protections, openAiKey });
		} catch (error) {
			// DeadlineExceededError escapes decide() by design (aiDecision
			// rethrows it) so the run aborts partial:true with no durable
			// writes — pinned by the omni/tone deadline-scoring tests.
			if (error instanceof DeadlineExceededError) throw error;
			throw new Error(`comment ${comment.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	})
);

	return settled;
}
function foldDecisions(settled: ScoreOutcome[]): { decisions: Decision[]; failures: string[]; deferred: number } {
const decisions: Decision[] = [];
const failures: string[] = [];
let deferred = 0;
for (const result of settled) {
	if (result.status === 'fulfilled') {
		// Deferred decisions are never staged: they stay unprocessed so a
		// later run (after a top-up) re-fetches and scores them.
		if (result.value.deferred) {
			deferred += 1;
			continue;
		}
		decisions.push(result.value);
		continue;
	}
	// A rejected promise whose reason is a DeadlineExceededError (rethrown
	// from aiDecision via the wrapper above) aborts the whole batch.
	if (result.reason instanceof DeadlineExceededError) throw result.reason;
	failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
}
return { decisions, failures, deferred };
}
async function decideNewComments(
	channelId: string,
	page: CommentPage,
	{
		accessToken,
		toneLevel,
		protections,
		openAiKey,
		deadline,
		rescore,
		orgId,
		consumeCredits
	}: DecisionBatchOptions
): Promise<{ decisions: Decision[]; failures: string[]; deferred: number }> {
	const batch = await prepareDecisionBatch(channelId, page, {
		accessToken,
		toneLevel,
		protections,
		openAiKey,
		deadline,
		rescore,
		orgId,
		consumeCredits
	});
	const settled = await scoreComments(batch.newComments, {
		rulesForChannel: batch.rulesForChannel,
		allowlist: batch.allowlist,
		aiBudget: batch.aiBudget,
		videoContext: batch.videoContext,
		metadataError: batch.metadataError,
		deadline,
		protections,
		openAiKey
	});
	return foldDecisions(settled);
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
