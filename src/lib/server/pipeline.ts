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

const AUTO_BAN = 0.95;
const AUTO_REJECT = 0.76;
const QUEUE = 0.51;

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
/**
 * Safe scalar reason for the audit log. Non-Error rejections (SDK/fetch
 * errors) can carry enumerable credentials — response bodies, Authorization
 * headers, cookies — so they must NEVER be serialized into the channel-visible
 * reason; the raw error is logged server-side by aiUnavailable instead.
 */
function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return 'unknown error';
}

function aiUnavailable(comment: NewComment, error: unknown): Decision {
	// I11: a scoring failure never auto-approves, never auto-rejects, and
	// never aborts the batch — the comment lands in the human review queue.
	// Full diagnostics go to the server log; the persisted reason is a safe
	// scalar (errorText) so credentials on SDK errors never reach the log page.
	console.error('[pipeline] ai unavailable for comment', comment.id, error);
	return {
		comment,
		status: 'pending',
		decidedBy: 'none',
		matchedRuleId: null,
		aiScore: null,
		auditAction: 'queue',
		reason: `ai unavailable: ${errorText(error)}`.slice(0, 200),
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

/**
 * Determines a moderation outcome using allowlist protection, matching rules, or AI scoring.
 *
 * Allowlisted handles take precedence over rules and scoring. Comments without an allowlist
 * entry or matching rule consume one AI budget unit; comments with no remaining budget are
 * deferred.
 *
 * @param comment - The comment to evaluate
 * @param rules - The prepared moderation rules
 * @param allowlist - Protected author handles
 * @param tone - Optional tone-scoring context
 * @param deadline - Optional processing deadline
 * @param protections - Tone-scoring protections and thresholds
 * @param openAiKey - Optional key for AI scoring
 * @param aiBudget - Remaining AI budget for the current batch
 * @returns The moderation decision for the comment
 */
/**
 * Allowlist and rule outcomes, decided BEFORE any AI budget is touched.
 * Returns null when neither applies, so decide() can fall through to AI.
 */
function preAiDecision(comment: NewComment, rules: PreparedRule[], allowlist: Set<string>): Decision | null {
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
	if (rule) return ruleDecision(comment, rule);
	return null;
}

async function decide(
	comment: NewComment,
	rules: PreparedRule[],
	allowlist: Set<string>,
	tone: { context: ToneContext } | null,
	aiBudget: { remaining: number },
	options: AiOptions
): Promise<Decision> {
	const preAi = preAiDecision(comment, rules, allowlist);
	if (preAi) return preAi;
	// Metered AI: claim one credit of the batch's AI budget SYNCHRONOUSLY —
	// before any await — so the concurrent decide() workers in Promise.allSettled
	// can never over-spend it. Rules/allowlist above never consume budget.
	// Out of credits: rules/allowlist already had their say — only the AI step
	// is paused (product choice). The comment stays unprocessed and the cursor
	// parks so a later run scores it once credits are topped up.
	if (!(aiBudget.remaining > 0)) return deferredDecision(comment);
	aiBudget.remaining -= 1;
	// The budget claim IS the billing marker: this decision consumed an AI
	// call, so stageDecisions may charge it exactly one credit.
	return { ...(await aiDecision(comment, tone, options.deadline, options.protections, options.openAiKey)), billable: true };
}

/**
 * Defers moderation for a comment when no AI credit is available.
 *
 * @returns A pending decision marked as deferred and requiring no action.
 */
function deferredDecision(comment: NewComment): Decision {
	return {
		comment,
		status: 'pending',
		decidedBy: 'none',
		matchedRuleId: null,
		aiScore: null,
		auditAction: null,
		reason: null,
		youtubeAction: null,
		deferred: true
	};
}

/**
 * Builds audit records for moderation decisions.
 *
 * @param dryRun - Whether to mark records as dry-run entries and retain truncated comment text
 * @returns Audit records for decisions with an audit action and reason
 */
function auditRows(channelId: string, decisions: Decision[], dryRun: boolean) {
	// Stryker disable next-line MethodExpression: equivalent — every Decision producer (ruleDecision, aiUnavailable, aiOutcome) sets auditAction and reason, so the filter never drops a row
	return decisions
		.filter((decision): decision is Decision & { auditAction: string; reason: string } =>
			// Stryker disable next-line ConditionalExpression, LogicalOperator: equivalent — the predicate is constant true for every Decision the pipeline produces, so the operator choice is unobservable
			Boolean(decision.auditAction && decision.reason)
		)
		.map((decision) => {
			// The commenter's normalized handle — the same normalization the
			// allowlist compares against, so a log row reads exactly like a
			// protected-handles entry. normalizeHandle never throws, but a
			// blank/lone-'@' author name trims to '' — store NULL in that case:
			// a handle is either meaningful or absent, never an empty string.
			const authorHandle = normalizeHandle(decision.comment.authorName) || null;
			return {
				channelId,
				commentId: decision.comment.id,
				action: dryRun ? 'dry-run' : decision.auditAction,
				reason: decision.reason,
				actor: 'system',
				authorHandle,
				// Dry run never inserts into comments (I8), so the audit row is the
				// only place the comment text survives — capped at 500 chars like
				// comments.text. Real runs leave it null (text lives in comments).
				...(dryRun ? { text: decision.comment.text.slice(0, 500) } : {}),
				createdAt: new Date().toISOString()
			};
		});
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
			// The normalized handle rides the staged row so the completion audit
			// row (written later by completeActions, long after the comment's
			// in-memory author data is gone) can still say WHO was moderated.
			// Same contract as auditRows: NULL when the name normalizes to ''.
			authorHandle: normalizeHandle(decision.comment.authorName) || null,
			state: 'pending',
			lastAttemptAt: null,
			lastManualRetryAt: null,
			createdAt
		}];
	});
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
async function stageDecisions(channelId: string, decisions: Decision[], orgId?: string | null) {
	if (!decisions.length) return;
	const actions = actionRows(channelId, decisions);
	await db.transaction(async (transaction) => {
		await transaction.insert(comments).values(commentRows(channelId, decisions));
		if (actions.length) await transaction.insert(moderationActions).values(actions);
		const audits = auditRows(channelId, decisions.filter((decision) => !decision.youtubeAction), false);
		if (audits.length) await transaction.insert(auditLog).values(audits);
		// One credit per BILLABLE decision (AI budget was claimed for it), in
		// the SAME transaction as the staging: a crash rolls both back and a
		// re-run can never double-charge (the ledger's UNIQUE(org_id, ref_type,
		// ref_id) anchor is the backstop). Rule/allowlist decisions are never
		// billed (billable is set only where decide() decrements the AI
		// budget); a comment whose charge fails (balance hit 0 mid-batch)
		// stages free.
		if (orgId) {
			// Unmetered orgs (NULL balance — self-hosted, lifetime, pre-billing)
			// are unlimited: their consumeCredit attempts are DESIGNED no-ops
			// (the NULL-balance guard rejects the charge), so only a METERED
			// org's failed charge is an anomaly worth aborting for.
			const metered = await orgIsMetered(orgId);
			for (const decision of decisions) {
				if (!decision.billable) continue;
				const charged = await consumeCredit(transaction as LedgerHandle, orgId, decision.comment.id);
				if (!charged && metered) {
					// The balance was exhausted CONCURRENTLY (another run of the
					// same org spent the credits between this run's budget read
					// and the atomic charge). The decision must NEVER stage free:
					// abort the staging transaction — the rollback leaves the
					// comments unprocessed, so the next run re-fetches them once
					// the org tops up (codex review). Loud: the caller sees the
					// run fail and the cron answers 500.
					throw new Error(
						`credit charge failed for comment ${decision.comment.id} (org ${orgId}) — staging aborted, balance exhausted concurrently`
					);
				}
			}
		}
	});
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
 * Stages decisions (live) or writes the audit trail (dry run) once the
 * channel is confirmed still active. Returns the acted count.
 */
async function stageOrAuditDecisions(
	channelId: string,
	decisions: Decision[],
	dryRun: boolean,
	orgId: string | null | undefined
): Promise<number> {
	if (dryRun) {
		const acted = decisions.filter((decision) => decision.youtubeAction).length;
		const audits = auditRows(channelId, decisions, true);
		if (audits.length) await db.insert(auditLog).values(audits);
		return acted;
	}
	await stageDecisions(channelId, decisions, orgId);
	return decisions.filter((decision) => decision.youtubeAction).length;
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
