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

import { db } from '$lib/server/db';
import { auditLog, comments } from '$lib/server/db/schema';
import { ownedChannel } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';
import { refreshAccessToken, setModerationStatus } from '$lib/server/youtube';
import { decrypt } from '$lib/server/crypto';
import { env } from '$env/dynamic/private';
import { error, fail } from '@sveltejs/kit';
import { and, eq, desc, inArray } from 'drizzle-orm';

export async function load({ params, locals }) {
	// Ownership-scoped: another user's channel (and its audit log) reads as "not found".
	const ch = await ownedChannel(params.id, locals);
	const rows = await db
		.select()
		.from(auditLog)
		.where(eq(auditLog.channelId, params.id))
		// createdAt ties (same-millisecond batch inserts) are broken by the
		// auto-increment id, or "latest per comment" is undefined behavior.
		.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
		.limit(200)
		.all();
	// Newest first: the first entry seen per comment is its latest action, and
	// only that one can be undone. 'hold'/'reject' reverse fully via YouTube;
	// 'ban' restores the comment but the author ban is permanent (no API);
	// everything else ('delete', 'approve', 'queue', 'dry-run', 'restore') is
	// not reversible.
	const seen = new Set<string>();
	const entries = rows.map((entry) => {
		const latest = !seen.has(entry.commentId);
		seen.add(entry.commentId);
		const undoable =
			latest && (entry.action === 'hold' || entry.action === 'reject')
				? 'full'
				: latest && entry.action === 'ban'
					? 'comment-only'
					: null;
		return { ...entry, undoable: undoable as 'full' | 'comment-only' | null };
	});
	// Project only what the page renders — never serialize refreshTokenEnc (or
	// any future secret column) to the browser.
	return { ch: { id: ch.id, title: ch.title }, entries };
}

export const actions = {
	/**
	 * Reverses a reversible moderation action: restores a held or rejected
	 * comment to published at YouTube (DB claim before the remote call, I3).
	 * Deleted comments are gone and author bans cannot be lifted — YouTube
	 * offers no API for either, so neither is undoable.
	 */
	undo: async ({ params, request, locals }) => {
		requireUser(locals);
		const raw = (await request.formData()).get('commentId');
		const commentId = typeof raw === 'string' ? raw.trim() : '';
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		const ch = await ownedChannel(params.id, locals);
		const comment = await db
			.select({ status: comments.status, decidedBy: comments.decidedBy })
			.from(comments)
			.where(and(eq(comments.id, commentId), eq(comments.channelId, params.id)))
			.get();
		if (!comment || (comment.status !== 'held' && comment.status !== 'rejected' && comment.status !== 'restoring')) {
			throw error(404, 'reversible comment not found in this channel');
		}
		// 'restoring' means a previous undo claimed the comment (or restored it
		// remotely) but crashed before the audit commit: resume it. The YouTube
		// call is idempotent (I4), so re-applying it is safe.
		const resuming = comment.status === 'restoring';
		if (!resuming) {
			// Atomically claim the comment BEFORE the external call: the conditional
			// update makes concurrent undo submissions single-winner (the loser 404s).
			const claimed = await db
				.update(comments)
				.set({ status: 'restoring' })
				.where(and(eq(comments.id, commentId), eq(comments.status, comment.status)))
				.returning({ id: comments.id });
			if (claimed.length === 0) throw error(404, 'reversible comment not found in this channel');
		}
		const dryRun = env.DRY_RUN === 'true';
		try {
			if (!dryRun) {
				const token = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
				await setModerationStatus([commentId], 'published', false, token);
			}
		} catch (e) {
			// Release a fresh claim so the failed restore stays retryable; a
			// resumed attempt stays 'restoring' either way.
			if (!resuming) {
				await db
					.update(comments)
					.set({ status: comment.status, decidedBy: comment.decidedBy })
					.where(eq(comments.id, commentId));
			}
			throw e;
		}
		// Name the action being undone — server-side, never from the form.
		const prior = await db
			.select({ action: auditLog.action })
			.from(auditLog)
			.where(and(eq(auditLog.channelId, params.id), eq(auditLog.commentId, commentId), inArray(auditLog.action, ['hold', 'reject', 'ban'])))
			.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
			.limit(1)
			.get();
		// The remote call already landed: the audit row and the final status
		// commit as one unit. If this transaction fails, the comment stays
		// 'restoring' — the next undo retries instead of losing the record.
		await db.transaction(async (tx) => {
			await tx.insert(auditLog).values({
				channelId: params.id,
				commentId,
				action: dryRun ? 'dry-run' : 'restore',
				reason: `undo of ${prior?.action ?? 'moderation action'}`,
				actor: 'user',
				createdAt: new Date().toISOString()
			});
			await tx.update(comments).set({ status: 'approved', decidedBy: 'human' }).where(eq(comments.id, commentId));
		});
		return { success: 'Restored — recorded in audit log.' };
	}
};
