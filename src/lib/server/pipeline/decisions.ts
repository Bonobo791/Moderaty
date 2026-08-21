// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; see LICENSE.

import { normalizeHandle } from '$lib/server/allowlist';
import { DeadlineExceededError } from '$lib/server/http';
import { scoreComment, serializeScores } from '$lib/server/moderation';
import { matchPreparedRule, type PreparedRule, type RuleAction } from '$lib/server/rules';
import { scoreTone, type ToneContext, type ToneProtections } from '$lib/server/tone';
import type { AiOptions, Decision } from './types';
import type { NewComment } from '$lib/server/youtube';

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
function errorText(_error: unknown): string {
	// Error messages from SDKs and upstream responses can contain credentials,
	// request headers, or response bodies. The full error is server-log-only;
	// the channel-visible reason must remain a fixed, non-sensitive summary.
	return 'scoring unavailable';
}

export function metadataUnavailable(
	comment: NewComment,
	rules: PreparedRule[],
	allowlist: Set<string>,
	error: unknown
): Decision {
	return preAiDecision(comment, rules, allowlist) ?? aiUnavailable(comment, error);
}

export function aiUnavailable(comment: NewComment, error: unknown): Decision {
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

export async function decide(
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
	if (aiBudget.remaining <= 0 || Number.isNaN(aiBudget.remaining)) return deferredDecision(comment);
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
