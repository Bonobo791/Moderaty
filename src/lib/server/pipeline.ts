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
import { decrypt } from '$lib/server/crypto';
import { db } from '$lib/server/db';
import { auditLog, channels, comments, moderationActions, rules } from '$lib/server/db/schema';
import { assertBeforeDeadline, DeadlineExceededError } from '$lib/server/http';
import { scoreComment, serializeScores } from '$lib/server/moderation';
import { matchRule, validateRule, type RuleAction, type RuleRow } from '$lib/server/rules';
import {
	deleteComment,
	fetchNewComments,
	getCommentModerationStatus,
	refreshAccessToken,
	setModerationStatus,
	type CommentPage,
	type NewComment
} from '$lib/server/youtube';

const AUTO_REJECT = 0.85;
const QUEUE = 0.35;

export interface RunChannelOptions {
	maxPages?: number;
	deadline?: number;
}

export interface ChannelRunResult {
	fetched: number;
	acted: number;
	queued: number;
	partial: boolean;
	skipped: boolean;
	dryRun: boolean;
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

/**
 * Creates the moderation outcome for a comment that matched a configured rule.
 *
 * @param comment - The comment to evaluate.
 * @param rule - The matched moderation rule.
 * @returns The moderation decision, including its status, rationale, and YouTube action.
 */
function ruleDecision(comment: NewComment, rule: RuleRow): Decision {
	validateRule(rule);
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

async function aiDecision(comment: NewComment, deadline?: number): Promise<Decision> {
	const moderation = await scoreComment(comment.text, deadline);
	const reason = `ai score ${moderation.score.toFixed(2)}`;
	const aiScore = serializeScores(moderation.scores);
	if (moderation.score >= AUTO_REJECT) {
		return {
			comment,
			status: 'rejected',
			decidedBy: 'ai',
			matchedRuleId: null,
			aiScore,
			auditAction: 'reject',
			reason,
			youtubeAction: 'reject'
		};
	}
	if (moderation.score >= QUEUE) {
		return {
			comment,
			status: 'pending',
			decidedBy: 'ai',
			matchedRuleId: null,
			aiScore,
			auditAction: 'queue',
			reason,
			youtubeAction: null
		};
	}
	return {
		comment,
		status: 'approved',
		decidedBy: 'ai',
		matchedRuleId: null,
		aiScore,
		auditAction: 'approve',
		reason,
		youtubeAction: null
	};
}

async function decide(comment: NewComment, rules: RuleRow[], deadline?: number): Promise<Decision> {
	const rule = matchRule(comment.text, comment.authorChannelId, rules);
	return rule ? ruleDecision(comment, rule) : aiDecision(comment, deadline);
}

function auditRows(channelId: string, decisions: Decision[], dryRun: boolean) {
	return decisions
		.filter((decision): decision is Decision & { auditAction: string; reason: string } =>
			Boolean(decision.auditAction && decision.reason)
		)
		.map((decision) => ({
			channelId,
			commentId: decision.comment.id,
			action: dryRun ? 'dry-run' : decision.auditAction,
			reason: decision.reason,
			actor: 'system',
			createdAt: new Date().toISOString()
		}));
}

function commentRows(channelId: string, decisions: Decision[]) {
	return decisions.map((decision) => ({
		id: decision.comment.id,
		channelId,
		authorChannelId: decision.comment.authorChannelId,
		authorName: decision.comment.authorName,
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
	deadline?: number
): Promise<Decision[]> {
	const existingIds = new Set(
		page.comments.length
			? (
					await db
						.select({ id: comments.id })
						.from(comments)
						.where(inArray(comments.id, page.comments.map((comment) => comment.id)))
						.all()
				).map((comment) => comment.id)
			: []
	);
	const rulesForChannel = await db.select().from(rules).where(eq(rules.channelId, channelId)).all();
	rulesForChannel.forEach(validateRule);
	return Promise.all(
		page.comments
			.filter((comment) => !existingIds.has(comment.id))
			.map((comment) => decide(comment, rulesForChannel, deadline))
	);
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
	if (action.state !== 'pending' && action.state !== 'dispatched') {
		throw new Error(`moderation action ${action.commentId} has invalid outstanding state: ${action.state}`);
	}
	return { ...action, action: validAction(action.action), state: action.state };
}

async function markDispatched(actions: OutstandingAction[]) {
	if (!actions.length) return;
	await db
		.update(moderationActions)
		.set({ state: 'dispatched', lastAttemptAt: new Date().toISOString() })
		.where(inArray(moderationActions.commentId, actions.map((action) => action.commentId)));
}

async function completeActions(actions: OutstandingAction[]) {
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

async function requireManualReview(action: OutstandingAction, detail: string): Promise<never> {
	await db
		.update(moderationActions)
		.set({ state: 'manual_review' })
		.where(eq(moderationActions.commentId, action.commentId));
	throw new Error(`moderation action ${action.commentId} requires manual review: ${detail}`);
}

async function verificationResult(
	action: OutstandingAction,
	accessToken: string,
	deadline: number | undefined
): Promise<'completed' | 'retry' | 'manual_review'> {
	assertBeforeDeadline(deadline);
	const status = await getCommentModerationStatus(action.commentId, accessToken, deadline);
	if (action.action === 'delete') return status === null ? 'completed' : 'retry';
	if (action.action === 'hold') return status === 'heldForReview' ? 'completed' : 'retry';
	if (action.action === 'reject') return status === 'rejected' ? 'completed' : 'retry';
	return status === 'rejected' || status === null ? 'manual_review' : 'retry';
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
	const ready: OutstandingAction[] = [];
	for (const action of actions) {
		if (action.state === 'pending') {
			ready.push(action);
			continue;
		}
		let result: 'completed' | 'retry' | 'manual_review' = 'manual_review';
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
		if (result === 'manual_review') {
			await requireManualReview(action, 'the author ban cannot be verified from the comment state');
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
	const newest = page.comments.map((comment) => comment.publishedAt).sort().at(-1) ?? channel.cursor;
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
	{ maxPages = 3, deadline }: RunChannelOptions = {}
): Promise<ChannelRunResult> {
	let fetched = 0;
	let acted = 0;
	let queued = 0;
	let dryRun = false;
	try {
		const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();
		if (!channel) throw new Error(`channel not found: ${channelId}`);
		if (!channel.active) return emptyResult();
		if (env.DRY_RUN !== 'true' && env.DRY_RUN !== 'false') {
			throw new Error('DRY_RUN must be true or false');
		}
		dryRun = env.DRY_RUN === 'true';
		const accessToken = await refreshAccessToken(decrypt(channel.refreshTokenEnc), deadline);
		const page = await fetchNewComments(channelId, accessToken, channel.cursor, {
			maxPages,
			pageToken: channel.nextPageToken,
			deadline
		});
		fetched = page.comments.length;

		const decisions = await decideNewComments(channelId, page, deadline);
		queued = decisions.filter((decision) => decision.auditAction === 'queue').length;

		if (dryRun) {
			acted = decisions.filter((decision) => decision.youtubeAction).length;
			const audits = auditRows(channelId, decisions, true);
			if (audits.length) await db.insert(auditLog).values(audits);
			return { fetched, acted, queued, partial: false, skipped: false, dryRun };
		}

		await stageDecisions(channelId, decisions);
		acted = await processOutstandingActions(channelId, accessToken, deadline);
		await persistResults(channelId, channel, page);
		return { fetched, acted, queued, partial: false, skipped: false, dryRun };
	} catch (error) {
		if (error instanceof DeadlineExceededError) {
			return { fetched, acted, queued, partial: true, skipped: false, dryRun };
		}
		throw error;
	}
}
