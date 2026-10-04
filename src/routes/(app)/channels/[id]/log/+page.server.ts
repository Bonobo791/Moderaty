import { db, withBusyRetry } from '$lib/server/db';
import { auditLog, comments, moderationActions } from '$lib/server/db/schema';
import { ownedChannel, requireOrgRole } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';
import { refreshAccessToken } from '$lib/server/youtube';
import { assertChannelActive, claimedHumanIntent, humanFinalStatus } from '$lib/server/pipeline/enforcement';
import { executeHumanDispatch, reserveHumanDispatch, HumanDispatchUncertainError, HumanFinalizeError, HUMAN_DISPATCH_BLOCKED, HUMAN_DISPATCH_UNCERTAIN } from '$lib/server/pipeline/human-dispatch';
import { decrypt } from '$lib/server/crypto';
import { env } from '$env/dynamic/private';
import { error, fail, isHttpError } from '@sveltejs/kit';
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
	if (locals.dbDown) return { ch: { id: params.id, title: '' }, entries: [], recovery: [], dispatches: [], canRecover: false, maintenance: true };
	// Ownership-scoped: another user's channel (and its audit log) reads as "not found".
	const ch = await ownedChannel(params.id, locals);
	const cursor = parseCursor(url.searchParams.get('before'));
	// Reservations on both restoring and already-decided comments remain
	// visible. Never expose the dispatch owner token to the browser.
	const dispatches = (await db.select({ id: comments.id, text: comments.text, state: comments.humanDispatchState })
		.from(comments).where(and(eq(comments.channelId, params.id),
			or(isNotNull(comments.humanDispatchToken), isNotNull(comments.humanDispatchState)))).all())
		.map((row) => ({ ...row, state: row.state === 'in_flight' ? 'in_flight' as const : 'uncertain' as const }));
	const dispatchIds = new Set(dispatches.map((row) => row.id));
	// Read claims independently of the audit page: legacy claims may have no
	// audit row at all. The stored status/binding keeps this error visible
	// until an owner explicitly records a new decision.
	const restoring = await db.select({
		id: comments.id, text: comments.text, restoreIntentId: comments.restoreIntentId,
		boundId: auditLog.id, action: auditLog.action
	}).from(comments).leftJoin(auditLog, and(
		eq(auditLog.id, comments.restoreIntentId), eq(auditLog.channelId, comments.channelId),
		eq(auditLog.commentId, comments.id), eq(auditLog.actor, 'user')
	)).where(and(eq(comments.channelId, params.id), eq(comments.status, 'restoring'))).all();
	const validClaims = new Map(restoring.filter((row) => row.boundId !== null && row.action !== null && humanFinalStatus(row.action))
		.map((row) => [row.id, row.action]));
	const recovery = restoring.filter((row) => !validClaims.has(row.id) && !dispatchIds.has(row.id))
		.map(({ id, text, restoreIntentId }) => ({ id, text, restoreIntentId }));
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
		undoable: dispatchIds.has(entry.commentId) || (statusById.get(entry.commentId) === 'restoring' && validClaims.get(entry.commentId) !== 'restore')
			? null : undoableFor(entry.id === latestIds.get(entry.commentId), entry.action, statusById.get(entry.commentId))
	}));
	const last = page.at(-1);
	const nextCursor = hasMore && last ? `${last.createdAt}|${last.id}` : null;
	// Project only what the page renders — never serialize refreshTokenEnc (or
	// any future secret column) to the browser.
	return { ch: { id: ch.id, title: ch.title }, entries, recovery, dispatches, canRecover: locals.user?.orgRole === 'owner', nextCursor, hasPrev: cursor !== null };
}

async function restore({ params, request, locals }: { params: { id: string }; request: Request; locals: App.Locals }, recovery = false) {
	requireUser(locals);
	const form = await request.formData();
	const raw = form.get('commentId');
	let expectedIntentId: number | null = null;
	if (recovery) {
		if (form.get('confirmRestore') !== 'yes') return fail(400, { error: 'Confirm that you want to publish this comment before restoring it.' });
		const expected = form.get('expectedIntentId');
		if (typeof expected !== 'string' || (expected !== '' && (!/^[1-9]\d*$/.test(expected) || !Number.isSafeInteger(Number(expected))))) {
			return fail(400, { error: 'Invalid recovery request. Refresh the log before retrying.' });
		}
		expectedIntentId = expected === '' ? null : Number(expected);
	}
	const commentId = typeof raw === 'string' ? raw.trim() : '';
	if (!commentId) return fail(400, { error: 'Invalid comment ID' });
	const ch = await ownedChannel(params.id, locals);
	const comment = await db
		.select({ status: comments.status, decidedBy: comments.decidedBy, restoreIntentId: comments.restoreIntentId, humanDispatchToken: comments.humanDispatchToken, humanDispatchState: comments.humanDispatchState })
		.from(comments)
		.where(and(eq(comments.id, commentId), eq(comments.channelId, params.id)))
		.get();
	if (recovery && (!comment || comment.status !== 'restoring' || comment.restoreIntentId !== expectedIntentId)) {
		return fail(409, { error: 'This pending action changed. Refresh the log before retrying.' });
	}
	if (!comment || (comment.status !== 'held' && comment.status !== 'rejected' && comment.status !== 'restoring')) {
		throw error(404, 'reversible comment not found in this channel');
	}
	if (comment.humanDispatchToken !== null || comment.humanDispatchState !== null) throw error(409, HUMAN_DISPATCH_BLOCKED);
	// A restoring row may belong to any human action. Ordinary Undo resumes
	// only a verified restore; owner recovery explicitly records a new one.
	const resuming = comment.status === 'restoring';
	const dryRun = env.DRY_RUN === 'true';
	const resumedIntent = async (tx: Pick<typeof db, 'select'>) => {
		if (!resuming) return null;
		const existing = await claimedHumanIntent(params.id, commentId, comment.restoreIntentId, tx);
		if (recovery) {
			if (existing) throw error(409, 'This comment has a verified pending action. Refresh the log and wait for it to finish.');
			return null;
		}
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
				.where(and(eq(comments.id, commentId), eq(comments.channelId, params.id), eq(comments.status, comment.status),
					comment.restoreIntentId === null ? isNull(comments.restoreIntentId) : eq(comments.restoreIntentId, comment.restoreIntentId),
					isNull(comments.humanDispatchToken), isNull(comments.humanDispatchState)))
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
				reason: recovery ? 'owner requested restore after blocked recovery' : `undo of ${prior?.action ?? 'moderation action'}`,
				actor: 'user',
				authorHandle: null,
				createdAt: new Date().toISOString()
			});
			return true;
		});
		if (!claimed) {
			if (recovery) return fail(409, { error: 'This pending action changed. Refresh the log before retrying.' });
			throw error(404, 'reversible comment not found in this channel');
		}
		return { success: 'Restored — recorded in audit log.' };
	}
	// Claim into 'restoring' and record the 'restore' intent row in ONE
	// transaction (I3): a crash leaves durable intent the reconcile sweep
	// re-executes — never a comment restored remotely with no local record.
	// Owner recovery records a new intent only when the observed claim is
	// still invalid; a verified pending human decision is never replaced.
	const claim = await withBusyRetry(() => db.transaction(async (tx) => {
		const rows = await tx
			.update(comments)
			.set({ status: 'restoring' })
			.where(and(eq(comments.id, commentId), eq(comments.channelId, params.id), eq(comments.status, comment.status),
				comment.restoreIntentId === null ? isNull(comments.restoreIntentId) : eq(comments.restoreIntentId, comment.restoreIntentId),
				isNull(comments.humanDispatchToken), isNull(comments.humanDispatchState)))
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
				reason: recovery ? 'owner requested restore after blocked recovery' : `undo of ${prior?.action ?? 'moderation action'}`,
				actor: 'user',
				// No handle source at manual-action time: comments.author_name is never persisted by design.
				authorHandle: null,
				createdAt: new Date().toISOString()
			})
			.returning({ id: auditLog.id });
		await tx.update(comments).set({ restoreIntentId: intent[0].id }).where(eq(comments.id, commentId));
		return { intentId: intent[0].id };
	}));
	if (!claim) {
		if (recovery) return fail(409, { error: 'This pending action changed. Refresh the log before retrying.' });
		throw error(404, 'reversible comment not found in this channel');
	}
	// 'missing' means YouTube reports the comment gone — nothing exists to
	// restore, so the honest outcome to finalize is 'deleted' (codex).
	let remoteMissing = false;
	try {
		// Revalidate the connector identity before spending the grant:
		// account deletion can have detached the channel since ownedChannel
		// loaded it. A failure before dispatch can release a fresh claim.
		await assertChannelActive(params.id, db, ch);
		const token = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
		const dispatch = await reserveHumanDispatch(params.id, commentId, claim.intentId, ch);
		if (!dispatch) return fail(409, { error: HUMAN_DISPATCH_BLOCKED });
		remoteMissing = (await executeHumanDispatch(dispatch, 'restore', token, ch)) === 'missing';
	} catch (e) {
		if (e instanceof HumanDispatchUncertainError) {
			console.error('log undo: uncertain YouTube outcome for comment %s — further actions paused', commentId, e);
			return fail(500, { error: HUMAN_DISPATCH_UNCERTAIN });
		}
		if (e instanceof HumanFinalizeError) {
			console.error('log undo: finalize failed for comment %s — reconcile sweep will finish it:', commentId, e);
			return fail(500, { error: 'The restore reached YouTube but saving it failed — it will finish automatically on the next moderation run.' });
		}
		// A known predispatch failure or settled refusal can release a fresh
		// claim. A resumed intent and any concurrent dispatch stay durable.
		if (!resuming) {
			await db.transaction(async (tx) => {
				const released = await tx
					.update(comments)
					.set({ status: comment.status, decidedBy: comment.decidedBy, restoreIntentId: null })
					.where(and(eq(comments.id, commentId), eq(comments.channelId, params.id), eq(comments.status, 'restoring'), eq(comments.restoreIntentId, claim.intentId),
						isNull(comments.humanDispatchToken), isNull(comments.humanDispatchState)))
					.returning({ id: comments.id });
				if (!released.length) return;
				await tx.delete(auditLog).where(eq(auditLog.id, claim.intentId));
			});
		}
		if (recovery) {
			console.error('log recovery: recorded restore failed for comment %s', commentId, e);
			return fail(500, { error: 'The restore failed. Your recorded restore request will retry on the next moderation run; refresh the log before retrying.' });
		}
		throw e;
	}
	return { success: remoteMissing ? 'The comment no longer exists on YouTube — recorded as deleted.' : 'Restored — recorded in audit log.' };
}

export const actions = {
	/** Restores a held/rejected comment or resumes its verified restore. */
	undo: (event) => restore(event),
	/** An owner explicitly requests a new restore for an unverifiable claim. */
	recoverRestore: async (event) => {
		const user = requireUser(event.locals);
		requireOrgRole(user, 'owner');
		try {
			return await restore(event, true);
		} catch (cause) {
			if (isHttpError(cause)) {
				if (cause.status !== 409) throw cause;
				console.warn('log recovery: claim changed for channel %s', event.params.id, cause);
				return fail(409, { error: cause.body.message });
			}
			console.error('log recovery: restore failed for channel %s', event.params.id, cause);
			return fail(500, { error: 'The restore could not be completed. Refresh the log to check whether a restore request was recorded before retrying.' });
		}
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
