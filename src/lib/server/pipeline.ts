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

import { eq, inArray } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { db } from '$lib/server/db';
import { auditLog, channels, comments, rules } from '$lib/server/db/schema';
import { assertBeforeDeadline, DeadlineExceededError } from '$lib/server/http';
import { scoreComment, serializeScores } from '$lib/server/moderation';
import {
	deleteComment,
	fetchNewComments,
	refreshAccessToken,
	setModerationStatus,
	type CommentPage,
	type NewComment
} from '$lib/server/youtube';

const AUTO_REJECT = 0.85;
const QUEUE = 0.35;

export interface RuleRow {
	id: number;
	type: string;
	pattern: string;
	action: string;
}

export interface RunChannelOptions {
	maxPages?: number;
	deadline?: number;
}

export interface ChannelRunResult {
	fetched: number;
	acted: number;
	queued: number;
	partial: boolean;
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

const RULE_ACTIONS = {
	hold: { status: 'held', auditAction: 'hold', youtubeAction: 'hold' },
	reject: { status: 'rejected', auditAction: 'reject', youtubeAction: 'reject' },
	delete: { status: 'deleted', auditAction: 'delete', youtubeAction: 'delete' },
	ban: { status: 'rejected', auditAction: 'ban', youtubeAction: 'ban' }
} as const;

/**
 * Finds the first moderation rule that matches the comment or its author.
 *
 * @param text - The comment text to evaluate.
 * @param authorChannelId - The channel ID of the comment author.
 * @param rules - The moderation rules to evaluate in order.
 * @returns The first matching rule, or `null` if no rule matches.
 */
export function matchRule(text: string, authorChannelId: string, rules: RuleRow[]): RuleRow | null {
	const lower = text.toLowerCase();
	for (const rule of rules) {
		if (rule.type === 'keyword' && lower.includes(rule.pattern.toLowerCase())) return rule;
		if (rule.type === 'user' && authorChannelId === rule.pattern) return rule;
		if (rule.type === 'regex') {
			try {
				if (new RegExp(rule.pattern, 'i').test(text)) return rule;
			} catch {
				// invalid user-supplied regex: skip the rule, never crash the pipeline
			}
		}
	}
	return null;
}

/**
 * Creates an empty channel run result with no processed comments or actions.
 *
 * @returns A zero-count result indicating that the run was not partial
 */
function emptyResult(): ChannelRunResult {
	return { fetched: 0, acted: 0, queued: 0, partial: false };
}

/**
 * Creates the moderation outcome for a comment that matched a configured rule.
 *
 * @param comment - The comment to evaluate.
 * @param rule - The matched moderation rule.
 * @returns The moderation decision, including its status, rationale, and YouTube action.
 */
function ruleDecision(comment: NewComment, rule: RuleRow): Decision {
	const action = rule.action in RULE_ACTIONS ? rule.action as keyof typeof RULE_ACTIONS : 'ban';
	const outcome = RULE_ACTIONS[action];
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
		auditAction: null,
		reason: null,
		youtubeAction: null
	};
}

async function decide(comment: NewComment, rules: RuleRow[], deadline?: number): Promise<Decision> {
	const rule = matchRule(comment.text, comment.authorChannelId, rules);
	return rule ? ruleDecision(comment, rule) : aiDecision(comment, deadline);
}

function auditRows(channelId: string, decisions: Decision[], dryRun: boolean) {
	return decisions
		.filter((decision) => decision.auditAction && decision.reason)
		.map((decision) => ({
			channelId,
			commentId: decision.comment.id,
			action: dryRun ? 'dry-run' : decision.auditAction!,
			reason: decision.reason!,
			actor: 'system',
			createdAt: new Date().toISOString()
		}));
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
	const decisions: Decision[] = [];
	for (const comment of page.comments) {
		if (!existingIds.has(comment.id)) decisions.push(await decide(comment, rulesForChannel, deadline));
	}
	return decisions;
}

async function applyYoutubeActions(decisions: Decision[], accessToken: string, deadline?: number) {
	const ids = (action: Decision['youtubeAction']) =>
		decisions.filter((decision) => decision.youtubeAction === action).map((decision) => decision.comment.id);
	const holds = ids('hold');
	const rejections = ids('reject');
	const bans = ids('ban');
	if (holds.length) await setModerationStatus(holds, 'heldForReview', false, accessToken, deadline);
	if (rejections.length) await setModerationStatus(rejections, 'rejected', false, accessToken, deadline);
	if (bans.length) await setModerationStatus(bans, 'rejected', true, accessToken, deadline);
	for (const commentId of ids('delete')) await deleteComment(commentId, accessToken, deadline);
}

async function persistResults(
	channelId: string,
	channel: typeof channels.$inferSelect,
	page: CommentPage,
	decisions: Decision[]
) {
	const newest = page.comments.map((comment) => comment.publishedAt).sort().at(-1) ?? channel.cursor;
	const scanCursor = channel.scanCursor ?? newest;
	const complete = page.reachedCursor || !page.nextPageToken;
	await db.transaction(async (transaction) => {
		if (decisions.length) {
			await transaction.insert(comments).values(
				decisions.map((decision) => ({
					id: decision.comment.id,
					channelId,
					authorChannelId: decision.comment.authorChannelId,
					authorName: decision.comment.authorName,
					text: decision.comment.text,
					publishedAt: decision.comment.publishedAt,
					status: decision.status,
					decidedBy: decision.decidedBy,
					matchedRuleId: decision.matchedRuleId,
					aiScore: decision.aiScore,
					createdAt: new Date().toISOString()
				}))
			);
		}
		const audits = auditRows(channelId, decisions, false);
		if (audits.length) await transaction.insert(auditLog).values(audits);
		await transaction
			.update(channels)
			.set(
				complete
					? { cursor: scanCursor, nextPageToken: null, scanCursor: null }
					: { nextPageToken: page.nextPageToken, scanCursor }
			)
			.where(eq(channels.id, channelId));
	});
}

/**
 * Processes new comments for an active channel and records moderation outcomes.
 *
 * @param channelId - The channel to scan and moderate
 * @param maxPages - The maximum number of comment pages to fetch
 * @param deadline - Optional execution deadline
 * @returns Counts of fetched, moderated, and queued comments, plus whether execution was interrupted
 */
export async function runChannel(
	channelId: string,
	{ maxPages = 3, deadline }: RunChannelOptions = {}
): Promise<ChannelRunResult> {
	let fetched = 0;
	let acted = 0;
	let queued = 0;
	try {
		const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();
		if (!channel || !channel.active) return emptyResult();
		const dryRun = process.env.DRY_RUN === 'true';
		const accessToken = await refreshAccessToken(decrypt(channel.refreshTokenEnc), deadline);
		const page = await fetchNewComments(channelId, accessToken, channel.cursor, {
			maxPages,
			pageToken: channel.nextPageToken,
			deadline
		});
		fetched = page.comments.length;

		const decisions = await decideNewComments(channelId, page, deadline);
		acted = decisions.filter((decision) => decision.youtubeAction).length;
		queued = decisions.filter((decision) => decision.auditAction === 'queue').length;

		if (dryRun) {
			const audits = auditRows(channelId, decisions, true);
			if (audits.length) await db.insert(auditLog).values(audits);
			return { fetched, acted, queued, partial: false };
		}

		await applyYoutubeActions(decisions, accessToken, deadline);
		assertBeforeDeadline(deadline);
		await persistResults(channelId, channel, page, decisions);
		return { fetched, acted, queued, partial: false };
	} catch (error) {
		if (error instanceof DeadlineExceededError) return { fetched, acted, queued, partial: true };
		throw error;
	}
}
