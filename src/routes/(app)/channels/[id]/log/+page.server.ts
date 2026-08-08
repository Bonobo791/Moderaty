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
import { auditLog, comments, moderationActions } from '$lib/server/db/schema';
import { ownedChannel } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';
import { refreshAccessToken, setModerationStatus } from '$lib/server/youtube';
import { decrypt } from '$lib/server/crypto';
import { env } from '$env/dynamic/private';
import { error, fail } from '@sveltejs/kit';
import { and, eq, desc, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';

/** Audit-log page size; the load fetches one extra row to detect a next page. */
const PAGE_SIZE = 200;

// Keyset cursor for a streaming log: offset paging would skip/duplicate rows
// as cron keeps inserting. The cursor is the (createdAt, id) pair of the last
// row on the current page — the same pair the ORDER BY sorts on.
function parseCursor(raw: string | null): { ts: string; id: number } | null {
	if (raw === null) return null;
	const sep = raw.lastIndexOf('|');
	const ts = sep === -1 ? '' : raw.slice(0, sep);
	const idRaw = sep === -1 ? '' : raw.slice(sep + 1);
	if (sep === -1 || Number.isNaN(Date.parse(ts)) || new Date(ts).toISOString() !== ts || !/^\d{1,15}$/.test(idRaw)) {
		throw error(400, 'invalid audit-log cursor');
	}
	return { ts, id: Number(idRaw) };
}

// Newest first: the first entry seen per comment is its latest action, and
// only that one can be undone. 'hold'/'reject' reverse fully via YouTube;
// 'ban' restores the comment but the author ban is permanent (no API);
// everything else ('delete', 'approve', 'queue', 'dry-run', 'restore') is
// not reversible.
function undoableFor(latest: boolean, action: string): 'full' | 'comment-only' | null {
	if (!latest) return null;
	if (action === 'hold' || action === 'reject') return 'full';
	if (action === 'ban') return 'comment-only';
	return null;
}

export async function load({ params, locals, url }) {
	// Database outage: the layout renders the overlay; this load must not 401
	// on the null-user outage shape.
	if (locals.dbDown) return { ch: { id: params.id, title: '' }, entries: [], maintenance: true };
	// Ownership-scoped: another user's channel (and its audit log) reads as "not found".
	const ch = await ownedChannel(params.id, locals);
	const cursor = parseCursor(url.searchParams.get('before'));
	const rows = await db
		.select()
		.from(auditLog)
		.where(
			and(
				eq(auditLog.channelId, params.id),
				cursor
					? or(lt(auditLog.createdAt, cursor.ts), and(eq(auditLog.createdAt, cursor.ts), lt(auditLog.id, cursor.id)))
					: undefined
			)
		)
		// createdAt ties (same-millisecond batch inserts) are broken by the
		// auto-increment id, or "latest per comment" is undefined behavior.
		.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
		.limit(PAGE_SIZE + 1)
		.all();
	const hasMore = rows.length > PAGE_SIZE;
	const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
	// "Latest per comment" must be judged against the WHOLE log, not the page —
	// a per-page window would mark a superseded action as latest and offer a
	// bogus Undo. Latest means the same (createdAt, id) ordering the page and
	// the undo handler sort by: audit writers stamp createdAt from app clocks
	// that can skew across serverless instances, so id order alone is NOT the
	// display order. Bounded by the page's comment ids.
	const latestIds = new Map<string, number>();
	if (page.length) {
		const commentIds = [...new Set(page.map((row) => row.commentId))];
		const latest = await db.all<{ commentId: string; latestId: number }>(sql`
			SELECT comment_id AS commentId, id AS latestId FROM (
				SELECT comment_id, id,
					ROW_NUMBER() OVER (PARTITION BY comment_id ORDER BY created_at DESC, id DESC) AS rn
				FROM ${auditLog}
				WHERE ${auditLog.channelId} = ${params.id}
					AND ${auditLog.commentId} IN (${sql.join(commentIds.map((commentId) => sql`${commentId}`), sql`, `)})
			) WHERE rn = 1
		`);
		for (const row of latest) latestIds.set(row.commentId, row.latestId);
	}
	const entries = page.map((entry) => ({
		...entry,
		undoable: undoableFor(entry.id === latestIds.get(entry.commentId), entry.action)
	}));
	const last = page.at(-1);
	const nextCursor = hasMore && last ? `${last.createdAt}|${last.id}` : null;
	// Project only what the page renders — never serialize refreshTokenEnc (or
	// any future secret column) to the browser.
	return { ch: { id: ch.id, title: ch.title }, entries, nextCursor, hasPrev: cursor !== null };
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
		// Stryker disable next-line ConditionalExpression, StringLiteral: →false/''-literal equivalent — when the comment IS 'restoring', judging it non-resuming only adds a re-claim `SET status='restoring' WHERE status='restoring'` (always matches, writes the value the row already holds) and a failure-release writing back the same selected values; observable state is identical. Sweeps the killable →true sibling, which stays pinned by the failed-audit test via the claim's 'restoring' effect.
		const resuming = comment.status === 'restoring';
		// Stryker disable next-line ConditionalExpression: →true equivalent — a resumed undo that re-claims issues `SET status='restoring' WHERE status='restoring'`, a no-op write that always matches one row, identical to skipping the claim; sweeps the killable →false sibling, which stays pinned by the failed-audit test (status must read 'restoring' after a failed audit commit).
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
			// Stryker disable next-line ConditionalExpression: →true equivalent — releasing a resumed attempt writes back exactly the values the row already holds (status 'restoring', the decidedBy just selected), so observable state is identical; sweeps the killable →false sibling, which stays pinned by the YouTube-failure release test.
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
				// No handle source at manual-action time: comments.author_name is never persisted by design.
				authorHandle: null,
				createdAt: new Date().toISOString()
			});
			await tx.update(comments).set({ status: 'approved', decidedBy: 'human' }).where(eq(comments.id, commentId));
		});
		return { success: 'Restored — recorded in audit log.' };
	},
	/**
	 * Erases every stored commenter handle on this channel immediately, ahead
	 * of the automatic 30-day retention sweep — audit rows AND staged
	 * moderation actions. Handles only: the rows, their text, and their
	 * outcomes stay as the moderation record. One transaction so the erase is
	 * atomic per channel — a failure on either table leaves both untouched
	 * rather than lying about what was erased.
	 */
	eraseHandles: async ({ params, locals }) => {
		requireUser(locals);
		// Ownership-scoped: another org's channel reads as "not found".
		await ownedChannel(params.id, locals);
		await db.transaction(async (tx) => {
			await tx
				.update(auditLog)
				.set({ authorHandle: null })
				.where(and(eq(auditLog.channelId, params.id), isNotNull(auditLog.authorHandle)));
			await tx
				.update(moderationActions)
				.set({ authorHandle: null })
				.where(and(eq(moderationActions.channelId, params.id), isNotNull(moderationActions.authorHandle)));
		});
		return { success: 'Stored handles erased for this channel.' };
	}
};
