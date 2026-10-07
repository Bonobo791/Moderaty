import { db, withBusyRetry } from '$lib/server/db';
import { auditLog, comments, moderationActions } from '$lib/server/db/schema';
import { ownedChannel, requireOrgRole } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';
import { refreshAccessToken } from '$lib/server/youtube';
import { assertChannelActive, claimedHumanIntent, humanFinalStatus } from '$lib/server/pipeline/enforcement';
import { executeHumanDispatch, reserveHumanDispatch, HumanDispatchUncertainError, HumanFinalizeError, HUMAN_DISPATCH_BLOCKED, HUMAN_DISPATCH_UNCERTAIN } from '$lib/server/pipeline/human-dispatch';
import { decrypt } from '$lib/server/crypto';
import { env } from '$env/dynamic/private';
import { error, fail, isHttpError, type ActionFailure } from '@sveltejs/kit';
import { and, asc, eq, desc, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

/** Audit-log page size; the load fetches one extra row to detect a next page. */
const PAGE_SIZE = 200;
const RECOVERY_PAGE_SIZE = 100;

function listLinks(url: URL, parameter: string, nextId: string | null) {
	const next = new URL(url);
	if (nextId !== null) next.searchParams.set(parameter, nextId);
	const first = new URL(url);
	first.searchParams.delete(parameter);
	return {
		next: nextId === null ? null : `${next.pathname}${next.search}`,
		first: url.searchParams.has(parameter) ? `${first.pathname}${first.search}` : null
	};
}

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

function boundAuditJoin() {
	return and(eq(auditLog.id, comments.restoreIntentId), eq(auditLog.channelId, comments.channelId),
		eq(auditLog.commentId, comments.id), eq(auditLog.actor, 'user'));
}

async function loadDispatchPage(channelId: string, url: URL) {
	const afterDispatch = url.searchParams.get('afterDispatch');
	// Reservations on both restoring and already-decided comments remain
	// visible. Never expose the dispatch owner token to the browser.
	const dispatchRows = await db.select({ id: comments.id, text: comments.text, state: comments.humanDispatchState })
		.from(comments).where(and(eq(comments.channelId, channelId),
			or(isNotNull(comments.humanDispatchToken), isNotNull(comments.humanDispatchState)),
			afterDispatch === null ? undefined : gt(comments.id, afterDispatch)))
		.orderBy(asc(comments.id)).limit(RECOVERY_PAGE_SIZE + 1).all();
	const dispatches = dispatchRows.slice(0, RECOVERY_PAGE_SIZE)
		.map((row) => ({ ...row, state: row.state === 'in_flight' ? 'in_flight' as const : 'uncertain' as const }));
	const dispatchLinks = listLinks(url, 'afterDispatch', dispatchRows.length > RECOVERY_PAGE_SIZE ? dispatches.at(-1)?.id ?? null : null);
	return { dispatches, nextDispatchHref: dispatchLinks.next, firstDispatchHref: dispatchLinks.first };
}

async function loadRecoveryPage(channelId: string, url: URL) {
	const afterRecovery = url.searchParams.get('afterRecovery');
	// Read claims independently of the audit page: legacy claims may have no
	// audit row at all. The stored status/binding keeps this error visible
	// until an owner explicitly records a new decision.
	const restoring = await db.select({
		id: comments.id, text: comments.text, restoreIntentId: comments.restoreIntentId,
		humanDispatchToken: comments.humanDispatchToken, humanDispatchState: comments.humanDispatchState,
		boundId: auditLog.id, action: auditLog.action
	}).from(comments).leftJoin(auditLog, boundAuditJoin()).where(and(eq(comments.channelId, channelId), eq(comments.status, 'restoring'),
		afterRecovery === null ? undefined : gt(comments.id, afterRecovery)))
		.orderBy(asc(comments.id)).limit(RECOVERY_PAGE_SIZE + 1).all();
	// Page the raw claims before filtering. A page can contain no invalid
	// claims but still has a visible continuation, keeping DB work bounded.
	const restoringPage = restoring.slice(0, RECOVERY_PAGE_SIZE);
	const recovery = restoringPage.filter((row) => !(row.boundId !== null && row.action !== null && humanFinalStatus(row.action))
		&& row.humanDispatchToken === null && row.humanDispatchState === null)
		.map(({ id, text, restoreIntentId }) => ({ id, text, restoreIntentId }));
	const recoveryLinks = listLinks(url, 'afterRecovery', restoring.length > RECOVERY_PAGE_SIZE ? restoringPage.at(-1)?.id ?? null : null);
	return { recovery, nextRecoveryHref: recoveryLinks.next, firstRecoveryHref: recoveryLinks.first };
}

async function auditPageMetadata(channelId: string, page: (typeof auditLog.$inferSelect)[]) {
	// "Latest per comment" must be judged against the WHOLE log, not the page —
	// a per-page window would mark a superseded action as latest and offer a
	// bogus Undo. Latest means the same (createdAt, id) ordering the page and
	// the undo handler sort by: audit writers stamp createdAt from app clocks
	// that can skew across serverless instances, so id order alone is NOT the
	// display order. Bounded by the page's comment ids.
	const latestIds = new Map<string, number>();
	const statusById = new Map<string, string>();
	const validClaims = new Map<string, string>();
	const dispatchIds = new Set<string>();
	if (page.length) {
		const commentIds = [...new Set(page.map((row) => row.commentId))];
		const latest = await db.all<{ commentId: string; latestId: number }>(sql`
			SELECT comment_id AS commentId, id AS latestId FROM (
				SELECT comment_id, id,
					ROW_NUMBER() OVER (PARTITION BY comment_id ORDER BY created_at DESC, id DESC) AS rn
				FROM ${auditLog}
				WHERE ${auditLog.channelId} = ${channelId}
					AND ${auditLog.commentId} IN (${sql.join(commentIds.map((commentId) => sql`${commentId}`), sql`, `)})
			) WHERE rn = 1
		`);
		for (const row of latest) latestIds.set(row.commentId, row.latestId);
		// Comment status gates Undo the same way the handler does: offering it
		// on a comment the handler would reject is a guaranteed-404 button.
		const statusRows = await db
			.select({ id: comments.id, status: comments.status, boundId: auditLog.id, action: auditLog.action,
				humanDispatchToken: comments.humanDispatchToken, humanDispatchState: comments.humanDispatchState })
			.from(comments)
			.leftJoin(auditLog, boundAuditJoin())
			.where(and(eq(comments.channelId, channelId), inArray(comments.id, commentIds)))
			.all();
		for (const row of statusRows) {
			statusById.set(row.id, row.status);
			if (row.boundId !== null && row.action !== null && humanFinalStatus(row.action)) validClaims.set(row.id, row.action);
			if (row.humanDispatchToken !== null || row.humanDispatchState !== null) dispatchIds.add(row.id);
		}
	}
	return { latestIds, statusById, validClaims, dispatchIds };
}

export async function load({ params, locals, url }) {
	// Database outage: the layout renders the overlay; this load must not 401
	// on the null-user outage shape.
	if (locals.dbDown) return { ch: { id: params.id, title: '' }, entries: [], recovery: [], dispatches: [], canRecover: false, maintenance: true,
		nextDispatchHref: null, firstDispatchHref: null, nextRecoveryHref: null, firstRecoveryHref: null };
	// Ownership-scoped: another user's channel (and its audit log) reads as "not found".
	const ch = await ownedChannel(params.id, locals);
	const cursor = parseCursor(url.searchParams.get('before'));
	const { dispatches, nextDispatchHref, firstDispatchHref } = await loadDispatchPage(params.id, url);
	const { recovery, nextRecoveryHref, firstRecoveryHref } = await loadRecoveryPage(params.id, url);
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
	const { latestIds, statusById, validClaims, dispatchIds } = await auditPageMetadata(params.id, page);
	const entries = page.map((entry) => ({
		...entry,
		undoable: dispatchIds.has(entry.commentId) || (statusById.get(entry.commentId) === 'restoring' && validClaims.get(entry.commentId) !== 'restore')
			? null : undoableFor(entry.id === latestIds.get(entry.commentId), entry.action, statusById.get(entry.commentId))
	}));
	const last = page.at(-1);
	const nextCursor = hasMore && last ? `${last.createdAt}|${last.id}` : null;
	// Project only what the page renders — never serialize refreshTokenEnc (or
	// any future secret column) to the browser.
	return { ch: { id: ch.id, title: ch.title }, entries, recovery, dispatches, nextRecoveryHref, firstRecoveryHref, nextDispatchHref, firstDispatchHref, canRecover: locals.user?.orgRole === 'owner', nextCursor, hasPrev: cursor !== null };
}

type RestoreComment = Pick<typeof comments.$inferSelect,
	'status' | 'decidedBy' | 'restoreIntentId' | 'humanDispatchToken' | 'humanDispatchState'>;
type RestoreContext = { channelId: string; commentId: string; comment: RestoreComment; recovery: boolean };
type RestoreTransaction = Pick<typeof db, 'select' | 'update' | 'insert' | 'delete'>;

type RestoreFailure = ActionFailure<{ error: string }>;
async function parseRestoreRequest(request: Request, recovery: boolean): Promise<{ commentId: string; expectedIntentId: number | null } | { failure: RestoreFailure }> {
	const form = await request.formData();
	const raw = form.get('commentId');
	let expectedIntentId: number | null = null;
	if (recovery) {
		if (form.get('confirmRestore') !== 'yes') return { failure: fail(400, { error: 'Confirm that you want to publish this comment before restoring it.' }) };
		const expected = form.get('expectedIntentId');
		if (typeof expected !== 'string' || (expected !== '' && (!/^[1-9]\d*$/.test(expected) || !Number.isSafeInteger(Number(expected))))) {
			return { failure: fail(400, { error: 'Invalid recovery request. Refresh the log before retrying.' }) };
		}
		expectedIntentId = expected === '' ? null : Number(expected);
	}
	const commentId = typeof raw === 'string' ? raw.trim() : '';
	if (!commentId) return { failure: fail(400, { error: 'Invalid comment ID' }) };
	return { commentId, expectedIntentId };
}

function validateRestoreComment(comment: RestoreComment | undefined, recovery: boolean, expectedIntentId: number | null): { comment: RestoreComment } | { failure: RestoreFailure } {
	if (recovery && (comment?.status !== 'restoring' || comment.restoreIntentId !== expectedIntentId)) {
		return { failure: changedRestoreClaim(true) };
	}
	if (!comment || (comment.status !== 'held' && comment.status !== 'rejected' && comment.status !== 'restoring')) {
		throw error(404, 'reversible comment not found in this channel');
	}
	if (comment.humanDispatchToken !== null || comment.humanDispatchState !== null) throw error(409, HUMAN_DISPATCH_BLOCKED);
	return { comment };
}

function changedRestoreClaim(recovery: boolean) {
	if (recovery) return fail(409, { error: 'This pending action changed. Refresh the log before retrying.' });
	throw error(404, 'reversible comment not found in this channel');
}

function restoreClaimGuard({ channelId, commentId, comment }: RestoreContext) {
	return and(eq(comments.id, commentId), eq(comments.channelId, channelId), eq(comments.status, comment.status),
		comment.restoreIntentId === null ? isNull(comments.restoreIntentId) : eq(comments.restoreIntentId, comment.restoreIntentId),
		isNull(comments.humanDispatchToken), isNull(comments.humanDispatchState));
}

async function resumedRestoreIntent({ channelId, commentId, comment, recovery }: RestoreContext, tx: Pick<typeof db, 'select'>) {
	// Ordinary Undo resumes only a verified restore; owner recovery explicitly
	// records a new one only while the observed legacy binding remains invalid.
	if (comment.status !== 'restoring') return null;
	const existing = await claimedHumanIntent(channelId, commentId, comment.restoreIntentId, tx);
	if (recovery) {
		if (existing) throw error(409, 'This comment has a verified pending action. Refresh the log and wait for it to finish.');
		return null;
	}
	if (existing?.action !== 'restore') {
		throw error(409, 'This comment has a different or invalid pending action. Refresh the log or contact support before retrying Undo.');
	}
	return { intentId: existing.id };
}

async function restoreAuditValues(tx: Pick<typeof db, 'select'>, { channelId, commentId, recovery }: RestoreContext, action: 'dry-run' | 'restore') {
	// Name the action being undone server-side, never from the form.
	const prior = await tx.select({ action: auditLog.action }).from(auditLog)
		.where(and(eq(auditLog.channelId, channelId), eq(auditLog.commentId, commentId), inArray(auditLog.action, ['hold', 'reject', 'ban'])))
		.orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(1).get();
	return {
		channelId, commentId, action,
		reason: recovery ? 'owner requested restore after blocked recovery' : `undo of ${prior?.action ?? 'moderation action'}`,
		actor: 'user' as const,
		// No handle source at manual-action time; author names are not persisted.
		authorHandle: null,
		createdAt: new Date().toISOString()
	};
}

async function recordDryRunRestore(context: RestoreContext) {
	// Final status and the dry-run audit row commit atomically.
	return await db.transaction(async (tx) => {
		await resumedRestoreIntent(context, tx);
		const rows = await tx.update(comments).set({ status: 'approved', decidedBy: 'human', restoreIntentId: null })
			.where(restoreClaimGuard(context)).returning({ id: comments.id });
		if (!rows.length) return false;
		await tx.insert(auditLog).values(await restoreAuditValues(tx, context, 'dry-run'));
		return true;
	});
}

async function claimRestore(context: RestoreContext) {
	// Claim and exact restore intent commit together before any remote write.
	return await withBusyRetry(() => db.transaction(async (tx) => {
		const rows = await tx.update(comments).set({ status: 'restoring' })
			.where(restoreClaimGuard(context)).returning({ id: comments.id });
		if (!rows.length) return null;
		const existing = await resumedRestoreIntent(context, tx);
		if (existing) return existing;
		const intent = await tx.insert(auditLog).values(await restoreAuditValues(tx, context, 'restore')).returning({ id: auditLog.id });
		await tx.update(comments).set({ restoreIntentId: intent[0].id }).where(eq(comments.id, context.commentId));
		return { intentId: intent[0].id };
	}));
}

async function releaseFreshRestore({ channelId, commentId, comment }: RestoreContext, intentId: number) {
	await db.transaction(async (tx: RestoreTransaction) => {
		const released = await tx.update(comments)
			.set({ status: comment.status, decidedBy: comment.decidedBy, restoreIntentId: null })
			.where(and(eq(comments.id, commentId), eq(comments.channelId, channelId), eq(comments.status, 'restoring'), eq(comments.restoreIntentId, intentId),
				isNull(comments.humanDispatchToken), isNull(comments.humanDispatchState)))
			.returning({ id: comments.id });
		if (!released.length) return;
		await tx.delete(auditLog).where(eq(auditLog.id, intentId));
	});
}

async function restoreFailure(e: unknown, context: RestoreContext, intentId: number) {
	const { commentId } = context;
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
	if (context.comment.status !== 'restoring') await releaseFreshRestore(context, intentId);
	if (context.recovery) {
		console.error('log recovery: recorded restore failed for comment %s', commentId, e);
		return fail(500, { error: 'The restore failed. Your recorded restore request will retry on the next moderation run; refresh the log before retrying.' });
	}
	throw e;
}

async function restore({ params, request, locals }: { params: { id: string }; request: Request; locals: App.Locals }, recovery = false) {
	requireUser(locals);
	const parsed = await parseRestoreRequest(request, recovery);
	if ('failure' in parsed) return parsed.failure;
	const { commentId, expectedIntentId } = parsed;
	const ch = await ownedChannel(params.id, locals);
	const comment = await db
		.select({ status: comments.status, decidedBy: comments.decidedBy, restoreIntentId: comments.restoreIntentId, humanDispatchToken: comments.humanDispatchToken, humanDispatchState: comments.humanDispatchState })
		.from(comments)
		.where(and(eq(comments.id, commentId), eq(comments.channelId, params.id)))
		.get();
	const validated = validateRestoreComment(comment, recovery, expectedIntentId);
	if ('failure' in validated) return validated.failure;
	const context = { channelId: params.id, commentId, comment: validated.comment, recovery };
	const dryRun = env.DRY_RUN === 'true';
	if (dryRun) {
		if (!await recordDryRunRestore(context)) return changedRestoreClaim(recovery);
		return { success: 'Restored — recorded in audit log.' };
	}
	const claim = await claimRestore(context);
	if (!claim) return changedRestoreClaim(recovery);
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
		return restoreFailure(e, context, claim.intentId);
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
