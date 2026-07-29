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
import { scoreComment } from '$lib/server/moderation';
import {
	deleteComment,
	fetchNewComments,
	refreshAccessToken,
	setModerationStatus,
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

function emptyResult(): ChannelRunResult {
	return { fetched: 0, acted: 0, queued: 0, partial: false };
}

async function decide(comment: NewComment, rules: RuleRow[], deadline?: number): Promise<Decision> {
	const rule = matchRule(comment.text, comment.authorChannelId, rules);
	if (rule) {
		const reason = `rule #${rule.id} (${rule.type}: ${rule.pattern.slice(0, 80)})`;
		if (rule.action === 'hold') {
			return {
				comment,
				status: 'held',
				decidedBy: 'rule',
				matchedRuleId: rule.id,
				aiScore: null,
				auditAction: 'hold',
				reason,
				youtubeAction: 'hold'
			};
		}
		if (rule.action === 'reject') {
			return {
				comment,
				status: 'rejected',
				decidedBy: 'rule',
				matchedRuleId: rule.id,
				aiScore: null,
				auditAction: 'reject',
				reason,
				youtubeAction: 'reject'
			};
		}
		if (rule.action === 'delete') {
			return {
				comment,
				status: 'deleted',
				decidedBy: 'rule',
				matchedRuleId: rule.id,
				aiScore: null,
				auditAction: 'delete',
				reason,
				youtubeAction: 'delete'
			};
		}
		return {
			comment,
			status: 'rejected',
			decidedBy: 'rule',
			matchedRuleId: rule.id,
			aiScore: null,
			auditAction: 'ban',
			reason,
			youtubeAction: 'ban'
		};
	}

	const moderation = await scoreComment(comment.text, deadline);
	const reason = `ai score ${moderation.score.toFixed(2)}`;
	if (moderation.score >= AUTO_REJECT) {
		return {
			comment,
			status: 'rejected',
			decidedBy: 'ai',
			matchedRuleId: null,
			aiScore: JSON.stringify(moderation.scores),
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
			aiScore: JSON.stringify(moderation.scores),
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
		aiScore: JSON.stringify(moderation.scores),
		auditAction: null,
		reason: null,
		youtubeAction: null
	};
}

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
			if (existingIds.has(comment.id)) continue;
			const decision = await decide(comment, rulesForChannel, deadline);
			decisions.push(decision);
			if (decision.youtubeAction) acted++;
			if (decision.auditAction === 'queue') queued++;
		}

		if (dryRun) {
			const audits = decisions
				.filter((decision) => decision.auditAction && decision.reason)
				.map((decision) => ({
					channelId,
					commentId: decision.comment.id,
					action: 'dry-run',
					reason: decision.reason!,
					actor: 'system',
					createdAt: new Date().toISOString()
				}));
			if (audits.length) await db.insert(auditLog).values(audits);
			return { fetched, acted, queued, partial: false };
		}

		const holds = decisions
			.filter((decision) => decision.youtubeAction === 'hold')
			.map((decision) => decision.comment.id);
		const rejections = decisions
			.filter((decision) => decision.youtubeAction === 'reject')
			.map((decision) => decision.comment.id);
		const bans = decisions
			.filter((decision) => decision.youtubeAction === 'ban')
			.map((decision) => decision.comment.id);
		const deletions = decisions
			.filter((decision) => decision.youtubeAction === 'delete')
			.map((decision) => decision.comment.id);
		if (holds.length) await setModerationStatus(holds, 'heldForReview', false, accessToken, deadline);
		if (rejections.length) await setModerationStatus(rejections, 'rejected', false, accessToken, deadline);
		if (bans.length) await setModerationStatus(bans, 'rejected', true, accessToken, deadline);
		for (const commentId of deletions) await deleteComment(commentId, accessToken, deadline);

		assertBeforeDeadline(deadline);
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
			const audits = decisions
				.filter((decision) => decision.auditAction && decision.reason)
				.map((decision) => ({
					channelId,
					commentId: decision.comment.id,
					action: decision.auditAction!,
					reason: decision.reason!,
					actor: 'system',
					createdAt: new Date().toISOString()
				}));
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
		return { fetched, acted, queued, partial: false };
	} catch (error) {
		if (error instanceof DeadlineExceededError) return { fetched, acted, queued, partial: true };
		throw error;
	}
}
