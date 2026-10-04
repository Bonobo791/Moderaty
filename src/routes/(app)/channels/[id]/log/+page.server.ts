import { db, withBusyRetry } from '$lib/server/db';
import { auditLog, comments, moderationActions } from '$lib/server/db/schema';
import { ownedChannel } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';
import { refreshAccessToken } from '$lib/server/youtube';
import { applyHumanIntent, assertChannelActive, claimedHumanIntent, finalizeHumanIntent } from '$lib/server/pipeline/enforcement';
import { decrypt } from '$lib/server/crypto';
import { env } from '$env/dynamic/private';
import { error, fail } from '@sveltejs/kit';
import { and, eq, desc, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

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
// not reversible. The undo handler only accepts decided comments
// (held/rejected/restoring), so a still-pending queue comment — whose
// completed 'hold' row IS its latest entry — must not offer an Undo that
// can only 404; the queue's own actions are the path. (A missing comment
// row is a test-only fixture: production deletes comments with their
// channel's audit rows.)
function undoableFor(latest: boolean, action: string, commentStatus: string | undefined): 'full' | 'comment-only' | null {
	if (!latest) return null;
	if (commentStatus !== undefined && commentStatus !== 'held' && commentStatus !== 'rejected' && commentStatus !== 'restoring') return null;
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
	const statusById = new Map<string, string>();
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
		// Comment status gates Undo the same way the handler does: offering it
		// on a comment the handler would reject is a guaranteed-404 button.
		const statusRows = await db
			.select({ id: comments.id, status: comments.status })
			.from(comments)
			.where(and(eq(comments.channelId, params.id), inArray(comments.id, commentIds)))
			.all();
		for (const row of statusRows) statusById.set(row.id, row.status);
	}
	const entries = page.map((entry) => ({
		...entry,
		undoable: undoableFor(entry.id === latestIds.get(entry.commentId), entry.action, statusById.get(entry.commentId))
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
			.select({ status: comments.status, decidedBy: comments.decidedBy, restoreIntentId: comments.restoreIntentId })
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
		const dryRun = env.DRY_RUN === 'true';
		const resumedIntent = async (tx: Pick<typeof db, 'select'>) => {
			if (!resuming || comment.restoreIntentId === null) return null;
			const existing = await claimedHumanIntent(params.id, commentId, comment.restoreIntentId, tx);
			if (!existing || existing.action !== 'restore') {
				throw error(409, 'This comment has a different or invalid pending action. Refresh the log or contact support before retrying Undo.');
			}
			return { intentId: existing.id };
		};
		if (dryRun) {
			// No remote call in dry run: final status and the dry-run audit row
			// commit atomically — nothing dangles between them.
			const claimed = await db.transaction(async (tx) => {
				await resumedIntent(tx);
				const rows = await tx
					.update(comments)
					.set({ status: 'approved', decidedBy: 'human', restoreIntentId: null })
					.where(and(eq(comments.id, commentId), eq(comments.status, comment.status),
						comment.restoreIntentId === null ? isNull(comments.restoreIntentId) : eq(comments.restoreIntentId, comment.restoreIntentId)))
					.returning({ id: comments.id });
				if (!rows.length) return false;
				// Name the action being undone — server-side, never from the form.
				const prior = await tx
					.select({ action: auditLog.action })
					.from(auditLog)
					.where(and(eq(auditLog.channelId, params.id), eq(auditLog.commentId, commentId), inArray(auditLog.action, ['hold', 'reject', 'ban'])))
					.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
					.limit(1)
					.get();
				await tx.insert(auditLog).values({
					channelId: params.id,
					commentId,
					action: 'dry-run',
					reason: `undo of ${prior?.action ?? 'moderation action'}`,
					actor: 'user',
					authorHandle: null,
					createdAt: new Date().toISOString()
				});
				return true;
			});
			if (!claimed) throw error(404, 'reversible comment not found in this channel');
			return { success: 'Restored — recorded in audit log.' };
		}
		// Claim into 'restoring' and record the 'restore' intent row in ONE
		// transaction (I3): a crash leaves durable intent the reconcile sweep
		// re-executes — never a comment restored remotely with no local record.
		// The resume path only fills in an intent row for a claim that crashed
		// before this durability existed.
		const claim = await withBusyRetry(() => db.transaction(async (tx) => {
			const rows = await tx
				.update(comments)
				.set({ status: 'restoring' })
				.where(and(eq(comments.id, commentId), eq(comments.status, comment.status),
					comment.restoreIntentId === null ? isNull(comments.restoreIntentId) : eq(comments.restoreIntentId, comment.restoreIntentId)))
				.returning({ id: comments.id });
			if (!rows.length) return null;
			const existing = await resumedIntent(tx);
			if (existing) return existing;
			// An explicit owner retry is new evidence for an unbound legacy
			// restore. Never infer that claim from an earlier audit row.
			// Name the action being undone — server-side, never from the form.
			const prior = await tx
				.select({ action: auditLog.action })
				.from(auditLog)
				.where(and(eq(auditLog.channelId, params.id), eq(auditLog.commentId, commentId), inArray(auditLog.action, ['hold', 'reject', 'ban'])))
				.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
				.limit(1)
				.get();
			const intent = await tx
				.insert(auditLog)
				.values({
					channelId: params.id,
					commentId,
					action: 'restore',
					reason: `undo of ${prior?.action ?? 'moderation action'}`,
					actor: 'user',
					// No handle source at manual-action time: comments.author_name is never persisted by design.
					authorHandle: null,
					createdAt: new Date().toISOString()
				})
				.returning({ id: auditLog.id });
			await tx.update(comments).set({ restoreIntentId: intent[0].id }).where(eq(comments.id, commentId));
			return { intentId: intent[0].id };
		}));
		if (!claim) throw error(404, 'reversible comment not found in this channel');
		// 'missing' means YouTube reports the comment gone — nothing exists to
		// restore, so the honest outcome to finalize is 'deleted' (codex).
		let remoteMissing = false;
		try {
			// Revalidate the connector identity before spending the grant:
			// account deletion can have detached the channel since ownedChannel
			// loaded it, and a remote write must never fire on a dead channel
			// (cubic). The catch releases a fresh claim like any remote failure.
			await assertChannelActive(params.id, db, ch);
			const token = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
			remoteMissing = (await applyHumanIntent(commentId, 'restore', token)) === 'missing';
		} catch (e) {
			// The remote write did not land: release a fresh claim so the
			// failed restore stays retryable and drop its staged intent row —
			// nothing committed. A resumed attempt keeps its claim and its
			// intent row: they belong to the earlier crash the reconcile
			// sweep still owes a finish.
			if (!resuming) {
				await db.transaction(async (tx) => {
					const released = await tx
						.update(comments)
						.set({ status: comment.status, decidedBy: comment.decidedBy, restoreIntentId: null })
						.where(and(eq(comments.id, commentId), eq(comments.status, 'restoring'), eq(comments.restoreIntentId, claim.intentId)))
						.returning({ id: comments.id });
					if (!released.length) return;
					await tx.delete(auditLog).where(eq(auditLog.id, claim.intentId));
				});
			}
			throw e;
		}
		// The publish landed — releasing the claim now would revert the local
		// row while YouTube already shows the comment, with no record left to
		// repair the desync (codeant). 'restoring' + the durable intent row
		// are exactly what the reconcile sweep needs to finish the commit.
		try {
			await finalizeHumanIntent(params.id, commentId, remoteMissing ? 'delete' : 'restore', claim.intentId, ch);
		} catch (e) {
			// Remote succeeded, local commit failed: keep the claim and the
			// intent row for the reconcile sweep, and tell the user it
			// resolves itself — an uncaught throw would surface the same 500
			// without explaining the self-heal (codex).
			console.error('log undo: finalize failed for comment %s — reconcile sweep will finish it:', commentId, e);
			return fail(500, { error: 'The restore reached YouTube but saving it failed — it will finish automatically on the next moderation run.' });
		}
		return { success: remoteMissing ? 'The comment no longer exists on YouTube — recorded as deleted.' : 'Restored — recorded in audit log.' };
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
