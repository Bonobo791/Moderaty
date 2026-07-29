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

import { eq } from 'drizzle-orm';
import { db } from './db';
import { channels, rules, comments, auditLog } from './db/schema';
import { decrypt } from './crypto';
import { refreshAccessToken, fetchNewComments, setModerationStatus, deleteComment } from './youtube';
import { scoreComment } from './moderation';

const AUTO_REJECT = 0.85;
const QUEUE = 0.35;

export interface RuleRow {
	id: number;
	type: string;
	pattern: string;
	action: string;
}

export function matchRule(text: string, authorChannelId: string, rs: RuleRow[]): RuleRow | null {
	const lower = text.toLowerCase();
	for (const r of rs) {
		if (r.type === 'keyword' && lower.includes(r.pattern.toLowerCase())) return r;
		if (r.type === 'user' && authorChannelId === r.pattern) return r;
		if (r.type === 'regex') {
			try {
				if (new RegExp(r.pattern, 'i').test(text)) return r;
			} catch {
				// invalid user-supplied regex: skip the rule, never crash the pipeline
			}
		}
	}
	return null;
}

async function log(channelId: string, commentId: string, action: string, reason: string, actor: string) {
	await db.insert(auditLog).values({
		channelId,
		commentId,
		action,
		reason,
		actor,
		createdAt: new Date().toISOString()
	});
}

export async function runChannel(channelId: string): Promise<{ fetched: number; acted: number; queued: number }> {
	const ch = await db.select().from(channels).where(eq(channels.id, channelId)).get();
	if (!ch || !ch.active) return { fetched: 0, acted: 0, queued: 0 };
	const dryRun = process.env.DRY_RUN === 'true';

	const accessToken = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
	const fresh = await fetchNewComments(channelId, accessToken, ch.cursor);
	if (fresh.length === 0) return { fetched: 0, acted: 0, queued: 0 };

	const rs = await db.select().from(rules).where(eq(rules.channelId, channelId)).all();

	const holdIds: string[] = [];
	const rejectIds: string[] = [];
	const banIds: string[] = [];
	let acted = 0;
	let queued = 0;

	for (const c of fresh) {
		const existing = await db.select().from(comments).where(eq(comments.id, c.id)).get();
		if (existing) continue;

		let status = 'pending';
		let decidedBy = 'none';
		let matchedRuleId: number | null = null;
		let aiScoreJson: string | null = null;

		const hit = matchRule(c.text, c.authorChannelId, rs);
		if (hit) {
			matchedRuleId = hit.id;
			decidedBy = 'rule';
			const reason = `rule #${hit.id} (${hit.type}: ${hit.pattern.slice(0, 80)})`;
			if (hit.action === 'hold') {
				status = 'held';
				holdIds.push(c.id);
				await log(channelId, c.id, dryRun ? 'dry-run' : 'hold', reason, 'system');
			} else if (hit.action === 'reject') {
				status = 'rejected';
				rejectIds.push(c.id);
				await log(channelId, c.id, dryRun ? 'dry-run' : 'reject', reason, 'system');
			} else if (hit.action === 'delete') {
				status = 'deleted';
				if (!dryRun) await deleteComment(c.id, accessToken);
				await log(channelId, c.id, dryRun ? 'dry-run' : 'delete', reason, 'system');
			} else if (hit.action === 'ban') {
				status = 'rejected';
				banIds.push(c.id);
				await log(channelId, c.id, dryRun ? 'dry-run' : 'ban', reason, 'system');
			}
			acted++;
		} else {
			const m = await scoreComment(c.text);
			aiScoreJson = JSON.stringify(m.scores);
			if (m.score >= AUTO_REJECT) {
				status = 'rejected';
				decidedBy = 'ai';
				rejectIds.push(c.id);
				await log(channelId, c.id, dryRun ? 'dry-run' : 'reject', `ai score ${m.score.toFixed(2)}`, 'system');
				acted++;
			} else if (m.score >= QUEUE) {
				status = 'pending';
				decidedBy = 'ai';
				queued++;
				await log(channelId, c.id, 'queue', `ai score ${m.score.toFixed(2)}`, 'system');
			} else {
				status = 'approved';
				decidedBy = 'ai';
			}
		}

		await db.insert(comments).values({
			id: c.id,
			channelId,
			authorChannelId: c.authorChannelId,
			authorName: c.authorName,
			text: c.text,
			publishedAt: c.publishedAt,
			status,
			decidedBy,
			matchedRuleId,
			aiScore: aiScoreJson,
			createdAt: new Date().toISOString()
		});
	}

	if (!dryRun) {
		if (holdIds.length) await setModerationStatus(holdIds, 'heldForReview', false, accessToken);
		if (rejectIds.length) await setModerationStatus(rejectIds, 'rejected', false, accessToken);
		if (banIds.length) await setModerationStatus(banIds, 'rejected', true, accessToken);
	}

	const newest = fresh.map((c) => c.publishedAt).sort().at(-1)!;
	await db.update(channels).set({ cursor: newest }).where(eq(channels.id, channelId));

	return { fetched: fresh.length, acted, queued };
}
