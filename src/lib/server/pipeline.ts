// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { and, eq, inArray } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { loadHandleSet, normalizeHandle } from '$lib/server/allowlist';
import { decrypt } from '$lib/server/crypto';
import { db } from '$lib/server/db';
import { auditLog, channels, comments, moderationActions, rules } from '$lib/server/db/schema';
import { assertBeforeDeadline, DeadlineExceededError } from '$lib/server/http';
import { scoreComment, serializeScores } from '$lib/server/moderation';
import { resolveOpenAiKey } from '$lib/server/openaiKey';
import { matchPreparedRule, prepareRules, type PreparedRule, type RuleAction } from '$lib/server/rules';
import { scoreTone, type ToneContext, type ToneProtections } from '$lib/server/tone';
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

const AUTO_BAN = 0.95;
const AUTO_REJECT = 0.76;
const QUEUE = 0.51;

export interface RunChannelOptions {
	maxPages?: number;
	deadline?: number;
	/** On-demand preview (dashboard button): forces dry-run semantics for this
	 * call. Can only turn dry-run ON — an env-dry deployment is never flipped
	 * live by a caller. */
	forceDryRun?: boolean;
	/** Dry-run drain over a time window: fetch one page bounded by `boundary`
	 * (ignoring the live cursor/checkpoint) and rescore even comments stored by
	 * real runs — re-scoring them is the point of the preview. Only meaningful
	 * with forceDryRun. The caller persists any continuation state. */
	window?: { boundary: string; pageToken: string | null };
}

export interface ChannelRunResult {
	fetched: number;
	acted: number;
	queued: number;
	partial: boolean;
	skipped: boolean;
	dryRun: boolean;
	/** Window-mode continuation: token for the next drain page (null when the
	 * window is exhausted) and whether the drain reached its boundary. Absent
	 * outside window mode. */
	windowNextPageToken?: string | null;
	windowComplete?: boolean;
}

interface Decision {
	comment: NewComment;
	status: string;
	decidedBy: string;
	matchedRuleId: number | null;
	aiScore: string | null;
	auditAction: string | null;
	reason: string | null;
	youtubeAction: 'hold' | 'reject' | 'delete' | 'ban' | null;
}

type YoutubeAction = Exclude<Decision['youtubeAction'], null>;
type OutstandingAction = typeof moderationActions.$inferSelect & {
	action: YoutubeAction;
	state: 'pending' | 'dispatched';
};

const RULE_ACTIONS: Record<RuleAction, {
	status: string;
	auditAction: string;
	youtubeAction: 'hold' | 'reject' | 'delete' | 'ban';
}> = {
	hold: { status: 'held', auditAction: 'hold', youtubeAction: 'hold' },
	reject: { status: 'rejected', auditAction: 'reject', youtubeAction: 'reject' },
	delete: { status: 'deleted', auditAction: 'delete', youtubeAction: 'delete' },
	ban: { status: 'rejected', auditAction: 'ban', youtubeAction: 'ban' }
} as const;

/**
 * Creates an empty channel run result with no processed comments or actions.
 *
 * @returns A zero-count result indicating that the channel was skipped
 */
function emptyResult(): ChannelRunResult {
	return { fetched: 0, acted: 0, queued: 0, partial: false, skipped: true, dryRun: false };
}

/** Thrown when account deletion deactivates (or removes) the channel mid-run. */
class ChannelDeactivatedError extends Error {}

/**
 * Re-checks that the channel is still active before durable writes and YouTube
 * enforcement. Account deletion commits `active = 0` without waiting for an
 * in-flight run, so the run must stop at the next boundary instead of writing
 * rows or moderating comments for a deleted account.
 */
async function assertChannelActive(channelId: string): Promise<void> {
	const row = await db
		.select({ active: channels.active })
		.from(channels)
		.where(eq(channels.id, channelId))
		.get();
	if (!row?.active) throw new ChannelDeactivatedError(`channel deactivated mid-run: ${channelId}`);
}

/**
 * Creates the moderation outcome for a comment that matched a configured rule.
 *
 * @param comment - The comment to evaluate.
 * @param rule - The matched moderation rule.
 * @returns The moderation decision, including its status, rationale, and YouTube action.
 */
function ruleDecision(comment: NewComment, rule: PreparedRule['rule']): Decision {
	const outcome = RULE_ACTIONS[rule.action];
	return {
		comment,
		...outcome,
		decidedBy: 'rule',
		matchedRuleId: rule.id,
		aiScore: null,
		reason: `rule #${rule.id} (${rule.type}: ${rule.pattern.slice(0, 80)})`
	};
}

/** Queues a comment for human review when AI scoring is unavailable (I11). */
function aiUnavailable(comment: NewComment, error: unknown): Decision {
	// I11: a scoring failure never auto-approves, never auto-rejects, and
	// never aborts the batch — the comment lands in the human review queue.
	return {
		comment,
		status: 'pending',
		decidedBy: 'none',
		matchedRuleId: null,
		aiScore: null,
		auditAction: 'queue',
		reason: `ai unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
		youtubeAction: null
	};
}

function aiOutcome(comment: NewComment, aiScore: string | null, signal: 'ai' | 'tone', score: number): Decision {
	const reason = `${signal} score ${score.toFixed(2)}`;
	if (score >= AUTO_BAN) {
		return { comment, status: 'rejected', decidedBy: 'ai', matchedRuleId: null, aiScore, auditAction: 'ban', reason, youtubeAction: 'ban' };
	}
	if (score >= AUTO_REJECT) {
		return { comment, status: 'rejected', decidedBy: 'ai', matchedRuleId: null, aiScore, auditAction: 'reject', reason, youtubeAction: 'reject' };
	}
	if (score >= QUEUE) {
		return { comment, status: 'pending', decidedBy: 'ai', matchedRuleId: null, aiScore, auditAction: 'queue', reason, youtubeAction: null };
	}
	return { comment, status: 'approved', decidedBy: 'ai', matchedRuleId: null, aiScore, auditAction: 'approve', reason, youtubeAction: null };
}

async function aiDecision(
	comment: NewComment,
	tone: { context: ToneContext } | null,
	deadline: number | undefined,
	protections: ToneProtections,
	openAiKey: string | undefined
): Promise<Decision> {
	let moderation: Awaited<ReturnType<typeof scoreComment>>;
	try {
		moderation = await scoreComment(comment.text, deadline, openAiKey);
	} catch (error) {
		// A deadline-expired score is a bounded-run abort (I10), not an AI
		// failure to queue (I11): rethrow so the run reports partial:true with
		// no durable writes, and the next invocation retries the batch.
		if (error instanceof DeadlineExceededError) throw error;
		return aiUnavailable(comment, error);
	}
	// Round to the displayed precision before comparing so a score that reads
	// as "0.51" in the audit log also behaves as 0.51 against the thresholds.
	const score = Math.round(moderation.score * 100) / 100;
	const aiScore = serializeScores(moderation.scores);
	// Omni already condemns the comment on its own — no need to spend a tone call.
	if (score >= AUTO_REJECT) return aiOutcome(comment, aiScore, 'ai', score);
	// Level 2 ("Edge lord + Ackchyually..."): the tone pass sees demeaning,
	// condescending, and sarcastic comments the safety classifier cannot. The
	// stronger of the two signals decides, on identical bands (tone included).
	if (tone) {
		let toneScore: number;
		try {
			toneScore = Math.round((await scoreTone(comment.text, tone.context, deadline, protections, openAiKey)).score * 100) / 100;
		} catch (error) {
			if (error instanceof DeadlineExceededError) throw error;
			return aiUnavailable(comment, error);
		}
		if (toneScore > score) return aiOutcome(comment, aiScore, 'tone', toneScore);
	}
	return aiOutcome(comment, aiScore, 'ai', score);
}

async function decide(
	comment: NewComment,
	rules: PreparedRule[],
	allowlist: Set<string>,
	tone: { context: ToneContext } | null,
	deadline: number | undefined,
	protections: ToneProtections,
	openAiKey: string | undefined
): Promise<Decision> {
	// Protected handles skip rules and scoring by design: identity beats text,
	// so even a matching ban rule loses to the allowlist.
	if (allowlist.has(normalizeHandle(comment.authorName))) {
		return {
			comment,
			status: 'approved',
			decidedBy: 'allowlist',
			matchedRuleId: null,
			aiScore: null,
			auditAction: 'approve',
			reason: 'protected handle',
			youtubeAction: null
		};
	}
	const rule = matchPreparedRule(comment.text, comment.authorChannelId, rules);
	return rule ? ruleDecision(comment, rule) : aiDecision(comment, tone, deadline, protections, openAiKey);
}

function auditRows(channelId: string, decisions: Decision[], dryRun: boolean) {
	// Stryker disable next-line MethodExpression: equivalent — every Decision producer (ruleDecision, aiUnavailable, aiOutcome) sets auditAction and reason, so the filter never drops a row
	return decisions
		.filter((decision): decision is Decision & { auditAction: string; reason: string } =>
			// Stryker disable next-line ConditionalExpression, LogicalOperator: equivalent — the predicate is constant true for every Decision the pipeline produces, so the operator choice is unobservable
			Boolean(decision.auditAction && decision.reason)
		)
		.map((decision) => ({
			channelId,
			commentId: decision.comment.id,
			action: dryRun ? 'dry-run' : decision.auditAction,
			reason: decision.reason,
			actor: 'system',
			// Dry run never inserts into comments (I8), so the audit row is the
			// only place the comment text survives — capped at 500 chars like
			// comments.text. Real runs leave it null (text lives in comments).
			...(dryRun ? { text: decision.comment.text.slice(0, 500) } : {}),
			createdAt: new Date().toISOString()
		}));
}

function commentRows(channelId: string, decisions: Decision[]) {
	// Process-and-discard for author PII: the display name and author channel
	// ID served their purpose at decision time (rule matching) and are never
	// persisted. Comment text IS stored (≤500 chars) so the review queue works.
	return decisions.map((decision) => ({
		id: decision.comment.id,
		channelId,
		text: decision.comment.text.slice(0, 500),
		publishedAt: decision.comment.publishedAt,
		status: decision.status,
		decidedBy: decision.decidedBy,
		matchedRuleId: decision.matchedRuleId,
		aiScore: decision.aiScore,
		createdAt: new Date().toISOString()
	}));
}

function actionRows(channelId: string, decisions: Decision[]) {
	const createdAt = new Date().toISOString();
	return decisions.flatMap((decision) => {
		if (!decision.youtubeAction) return [];
		// Stryker disable next-line ConditionalExpression, StringLiteral: equivalent — every youtubeAction decision carries a reason (all producers set both), so this guard never fires
		if (!decision.reason) throw new Error(`remote moderation decision ${decision.comment.id} is missing a reason`);
		return [{
			commentId: decision.comment.id,
			channelId,
			action: decision.youtubeAction,
			reason: decision.reason,
			state: 'pending',
			lastAttemptAt: null,
			lastManualRetryAt: null,
			createdAt
		}];
	});
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
		rescore
	}: { accessToken: string; toneLevel: number; protections: ToneProtections; openAiKey?: string; deadline?: number; rescore?: boolean }
): Promise<{ decisions: Decision[]; failures: string[] }> {
	// Dry-run window mode (rescore: true) skips the stored-IDs dedupe entirely:
	// re-scoring comments a real run already moderated is the point of the
	// preview. The within-batch dedupe below still applies. The DB query is
	// skipped in both no-consult cases (rescore, empty page).
	// Stryker disable ArrayDeclaration: equivalent — with an empty page there are no comments to consult existingIds for, so its contents are never read
	const storedIds =
		!rescore && page.comments.length
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
	// Level 2 tone scoring needs each video's title/description as context. One
	// batched videos.list call per run; videos whose metadata failed validation
	// (and comments carrying no videoId at all) score with empty context
	// (best-effort). If the videos.list call itself fails, the tone pass cannot
	// run — every new comment lands in the human queue (I11) rather than
	// aborting the batch or silently scoring omni-only. A ticked protection
	// flag forces the tone pass on even below level 2: the channel owner asked
	// for heightened scrutiny, so the checkbox must never be a silent no-op.
	const toneEnabled = toneLevel >= 2 || Boolean(protections.protectLgbtqia) || Boolean(protections.protectWomen);
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
	const settled = await Promise.allSettled(
		newComments.map(async (comment) => {
			try {
				if (metadataError) return aiUnavailable(comment, metadataError);
				// Stryker disable next-line ConditionalExpression: equivalent — for a null videoId both branches yield undefined (Map.get(null) misses), and a non-null id takes the false branch anyway
				const meta = comment.videoId === null ? undefined : videoContext?.get(comment.videoId);
				const tone = videoContext
					? { context: { videoTitle: meta?.title ?? '', videoDescription: meta?.description ?? '' } }
					: null;
				return await decide(comment, rulesForChannel, allowlist, tone, deadline, protections, openAiKey);
			} catch (error) {
				// DeadlineExceededError escapes decide() by design (aiDecision
				// rethrows it) so the run aborts partial:true with no durable
				// writes — pinned by the omni/tone deadline-scoring tests.
				if (error instanceof DeadlineExceededError) throw error;
				throw new Error(`comment ${comment.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		})
	);
	const decisions: Decision[] = [];
	const failures: string[] = [];
	for (const result of settled) {
		if (result.status === 'fulfilled') {
			decisions.push(result.value);
			continue;
		}
		// A rejected promise whose reason is a DeadlineExceededError (rethrown
		// from aiDecision via the wrapper above) aborts the whole batch.
		if (result.reason instanceof DeadlineExceededError) throw result.reason;
		failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
	}
	return { decisions, failures };
}

async function stageDecisions(channelId: string, decisions: Decision[]) {
	if (!decisions.length) return;
	const actions = actionRows(channelId, decisions);
	await db.transaction(async (transaction) => {
		await transaction.insert(comments).values(commentRows(channelId, decisions));
		if (actions.length) await transaction.insert(moderationActions).values(actions);
		const audits = auditRows(channelId, decisions.filter((decision) => !decision.youtubeAction), false);
		if (audits.length) await transaction.insert(auditLog).values(audits);
	});
}

function validAction(action: string): YoutubeAction {
	if (action === 'hold' || action === 'reject' || action === 'delete' || action === 'ban') return action;
	throw new Error(`moderation action is invalid: ${action}`);
}

function outstandingAction(action: typeof moderationActions.$inferSelect): OutstandingAction {
	// Stryker disable next-line ConditionalExpression, BlockStatement: equivalent — the only caller queries with inArray(state, ['pending','dispatched']), so no other state can reach this guard
	if (action.state !== 'pending' && action.state !== 'dispatched') {
		// Stryker disable next-line StringLiteral: equivalent — unreachable for the same reason as the guard above
		throw new Error(`moderation action ${action.commentId} has invalid outstanding state: ${action.state}`);
	}
	return { ...action, action: validAction(action.action), state: action.state };
}

async function markDispatched(actions: OutstandingAction[]) {
	// Stryker disable next-line ConditionalExpression: equivalent — both callers pass a non-empty array (applyModerationAction batches of ≥1, the delete loop a single action), so the empty-array branch is unreachable
	if (!actions.length) return;
	await db
		.update(moderationActions)
		.set({ state: 'dispatched', lastAttemptAt: new Date().toISOString() })
		.where(inArray(moderationActions.commentId, actions.map((action) => action.commentId)));
}

async function claimPendingActions(actions: OutstandingAction[]): Promise<Set<string>> {
	if (!actions.length) return new Set();
	const claimed = await db
		.update(moderationActions)
		.set({ state: 'dispatched' })
		.where(and(
			inArray(moderationActions.commentId, actions.map((action) => action.commentId)),
			eq(moderationActions.state, 'pending')
		))
		.returning({ commentId: moderationActions.commentId });
	return new Set(claimed.map((row) => row.commentId));
}

async function completeActions(actions: OutstandingAction[]) {
	// Stryker disable next-line ConditionalExpression: equivalent — all callers pass a non-empty array (applyModerationAction batches of ≥1, single verified or deleted actions)
	if (!actions.length) return;
	await db.transaction(async (transaction) => {
		await transaction
			.update(moderationActions)
			.set({ state: 'completed' })
			.where(inArray(moderationActions.commentId, actions.map((action) => action.commentId)));
		await transaction.insert(auditLog).values(actions.map((action) => ({
			channelId: action.channelId,
			commentId: action.commentId,
			action: action.action,
			reason: action.reason,
			actor: 'system',
			createdAt: new Date().toISOString()
		})));
	});
}

async function verificationResult(
	action: OutstandingAction,
	accessToken: string,
	deadline: number | undefined
): Promise<'completed' | 'retry'> {
	assertBeforeDeadline(deadline);
	const status = await getCommentModerationStatus(action.commentId, accessToken, deadline);
	// Stryker disable next-line StringLiteral: 'retry'→"" equivalent — the caller only compares result === 'completed', so every other string takes the identical retry path
	if (action.action === 'delete') return status === null ? 'completed' : 'retry';
	// Stryker disable next-line StringLiteral: 'retry'→"" equivalent — same reasoning as the delete branch above
	if (action.action === 'hold') return status === 'heldForReview' ? 'completed' : 'retry';
	// Stryker disable next-line StringLiteral: 'retry'→"" equivalent — same reasoning as the delete branch above
	if (action.action === 'reject') return status === 'rejected' ? 'completed' : 'retry';
	// Ban is a single atomic API call (reject + banAuthor), so a comment already
	// in a terminal state after dispatch means the call landed — complete it
	// rather than stranding the action in manual review.
	// Stryker disable next-line StringLiteral: 'retry'→"" equivalent — same reasoning as the delete branch above
	return status === 'rejected' || status === null ? 'completed' : 'retry';
}

async function applyModerationAction(
	actions: OutstandingAction[],
	status: 'heldForReview' | 'rejected',
	banAuthor: boolean,
	accessToken: string,
	deadline: number | undefined
): Promise<number> {
	let acted = 0;
	for (let index = 0; index < actions.length; index += 50) {
		const batch = actions.slice(index, index + 50);
		await markDispatched(batch);
		assertBeforeDeadline(deadline);
		await setModerationStatus(batch.map((action) => action.commentId), status, banAuthor, accessToken, deadline);
		await completeActions(batch);
		acted += batch.length;
	}
	return acted;
}

async function applyYoutubeActions(
	actions: OutstandingAction[],
	accessToken: string,
	deadline: number | undefined
): Promise<number> {
	const selected = (action: YoutubeAction) => actions.filter((item) => item.action === action);
	let acted = 0;
	acted += await applyModerationAction(selected('hold'), 'heldForReview', false, accessToken, deadline);
	acted += await applyModerationAction(selected('reject'), 'rejected', false, accessToken, deadline);
	acted += await applyModerationAction(selected('ban'), 'rejected', true, accessToken, deadline);
	for (const action of selected('delete')) {
		await markDispatched([action]);
		assertBeforeDeadline(deadline);
		await deleteComment(action.commentId, accessToken, deadline);
		await completeActions([action]);
		acted += 1;
	}
	return acted;
}

async function processOutstandingActions(channelId: string, accessToken: string, deadline?: number): Promise<number> {
	const actions = (await db
		.select()
		.from(moderationActions)
		.where(and(
			eq(moderationActions.channelId, channelId),
			inArray(moderationActions.state, ['pending', 'dispatched'])
		))
		.all()).map(outstandingAction);
	// Stryker disable next-line MethodExpression, ConditionalExpression: equivalent — claimPendingActions' SQL still guards eq(state, 'pending'), so handing it dispatched rows too claims nothing extra
	const claimed = await claimPendingActions(actions.filter((action) => action.state === 'pending'));
	// Stryker disable next-line ArrayDeclaration: equivalent — applyYoutubeActions selects entries by their action field, so a foreign element in the array is never selected
	const ready: OutstandingAction[] = [];
	for (const action of actions) {
		if (action.state === 'pending') {
			// Only actions this run claimed may be applied; an empty claim means a
			// concurrent run owns the action, so skip it to avoid duplicate enforcement.
			// Stryker disable next-line StringLiteral: equivalent — a ready entry's state field is never read again; applyYoutubeActions groups by action only
			if (claimed.has(action.commentId)) ready.push({ ...action, state: 'dispatched' });
			continue;
		}
		let result: 'completed' | 'retry';
		try {
			result = await verificationResult(action, accessToken, deadline);
		} catch (error) {
			// Transient verification failures must not strand the action: leave it
			// 'dispatched' so the next run re-verifies, and fail loudly.
			if (error instanceof DeadlineExceededError) throw error;
			throw new Error(
				`moderation action ${action.commentId} verification failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		if (result === 'completed') {
			await completeActions([action]);
			continue;
		}
		ready.push(action);
	}
	return applyYoutubeActions(ready, accessToken, deadline);
}

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

/**
 * Processes new comments for an active channel and records moderation outcomes.
 *
 * @param channelId - The channel to scan and moderate
 * @param maxPages - The maximum number of comment pages to fetch
 * @param deadline - Optional execution deadline
 * @returns Counts and explicit state for completed, simulated, skipped, or deadline-limited work
 * @throws If the channel, configuration, or stored rules are invalid
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
		const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();
		if (!channel) throw new Error(`channel not found: ${channelId}`);
		if (!channel.active) return emptyResult();
		if (env.DRY_RUN !== 'true' && env.DRY_RUN !== 'false') {
			throw new Error('DRY_RUN must be true or false');
		}
		dryRun = forceDryRun === true || env.DRY_RUN === 'true';
		// The window rescore skips the stored-IDs dedupe, so a live window run
		// would stage duplicate decisions and enforce on re-fetched comments —
		// the combination is refused loudly, before any fetch or write.
		if (window && !dryRun) throw new Error('window mode requires dry-run semantics (pass forceDryRun)');
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

		const { decisions, failures } = await decideNewComments(channelId, page, {
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
			rescore: window !== undefined
		});
		queued = decisions.filter((decision) => decision.auditAction === 'queue').length;

		// Deletion may have committed during the YouTube/AI calls above: re-check
		// before any durable write (I3) so a deleted account gets no new rows.
		await assertChannelActive(channelId);
		if (dryRun) {
			acted = decisions.filter((decision) => decision.youtubeAction).length;
			const audits = auditRows(channelId, decisions, true);
			if (audits.length) await db.insert(auditLog).values(audits);
		} else {
			await stageDecisions(channelId, decisions);
		}
		// Fail loudly only after successful decisions are staged, and before the
		// cursor advances, so the next run retries just the failed comments.
		if (failures.length) {
			throw new Error(`moderation decision failed for ${failures.length} comment(s): ${failures.join('; ')}`);
		}
		if (dryRun) {
			// Window-mode continuation is reported, never persisted here — the
			// caller owns the drain state (I8: a dry run touches no checkpoint).
			const windowState = window
				? {
						windowComplete: page.reachedCursor || !page.nextPageToken,
						windowNextPageToken: page.reachedCursor ? null : page.nextPageToken
					}
				: {};
			return { fetched, acted, queued, partial: false, skipped: false, dryRun, ...windowState };
		}

		// ... and again before any YouTube enforcement call.
		await assertChannelActive(channelId);
		acted = await processOutstandingActions(channelId, accessToken, deadline);
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
