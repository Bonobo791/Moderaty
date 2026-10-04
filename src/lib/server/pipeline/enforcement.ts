import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { maybeTriggerAutoTopUp } from '$lib/server/billing/autotopup';
import { db } from '$lib/server/db';
import { auditLog, channels, comments, moderationActions } from '$lib/server/db/schema';
import { assertBeforeDeadline, DeadlineExceededError, RequestNotSentError } from '$lib/server/http';
import {
	CommentNotFoundError,
	deleteComment,
	setModerationStatus,
	YOUTUBE_ID_BATCH_SIZE
} from '$lib/server/youtube';
import type { OutstandingAction, YoutubeAction } from './types';
import { executeDecidedDispatch, executeHumanDispatch, reserveDecidedDispatch, reserveHumanDispatch } from './human-dispatch';

/** Thrown when account deletion deactivates (or removes) the channel mid-run. */
export class ChannelDeactivatedError extends Error {}

/**
 * Re-checks that the channel is still active before durable writes and YouTube
 * enforcement. Account deletion commits `active = 0` without waiting for an
 * in-flight run, so the run must stop at the next boundary instead of writing
 * rows or moderating comments for a deleted account.
 */
export type ChannelIdentity = Pick<typeof channels.$inferSelect, 'userId' | 'refreshTokenEnc'>;
type ChannelGuardHandle = Pick<typeof db, 'update'>;
type OutstandingState = 'pending' | 'dispatched' | 'cancelling';

/**
 * Atomically claims a short-lived channel write boundary. The no-op UPDATE is
 * deliberately the first transaction operation: a SELECT-only check on
 * SQLite's deferred transaction can race account deletion before the next
 * INSERT/UPDATE. The connector identity predicate also invalidates a run when
 * account deletion detaches a shared-team channel without pausing it.
 */
export async function assertChannelActive(
	channelId: string,
	handle: ChannelGuardHandle = db,
	expected?: ChannelIdentity
): Promise<void> {
	const ownership = expected
		? expected.userId === null ? isNull(channels.userId) : eq(channels.userId, expected.userId)
		: undefined;
	const guarded = await handle
		.update(channels)
		.set({ active: sql`${channels.active}` })
		.where(and(
			eq(channels.id, channelId),
			eq(channels.active, 1),
			ownership,
			expected ? eq(channels.refreshTokenEnc, expected.refreshTokenEnc) : undefined
		))
		.returning({ id: channels.id });
	if (!guarded.length) throw new ChannelDeactivatedError(`channel deactivated mid-run: ${channelId}`);
}

function validAction(action: string): YoutubeAction {
	if (action === 'hold' || action === 'reject' || action === 'delete' || action === 'ban') return action;
	throw new Error(`moderation action is invalid: ${action}`);
}

function outstandingAction(action: typeof moderationActions.$inferSelect): OutstandingAction {
	// Stryker disable next-line ConditionalExpression, BlockStatement: equivalent — the only caller queries with inArray(state, ['pending','dispatched','cancelling']), so no other state can reach this guard
	if (action.state !== 'pending' && action.state !== 'dispatched' && action.state !== 'cancelling') {
		// Stryker disable next-line StringLiteral: equivalent — unreachable for the same reason as the guard above
		throw new Error(`moderation action ${action.commentId} has invalid outstanding state: ${action.state}`);
	}
	return { ...action, action: validAction(action.action), state: action.state };
}

function updateActionStates(
	transaction: ChannelGuardHandle,
	actions: OutstandingAction[],
	set: { state: 'dispatched' | 'superseded' | 'completed'; lastAttemptAt?: string },
	fromStates: OutstandingState[] = ['pending', 'dispatched', 'cancelling']
) {
	// Transitions only ever move outstanding rows: a terminal state must never
	// be rewritten by a stale run (completed→superseded) nor claimed by a row a
	// concurrent decider already finished. The predecessor predicate makes
	// every transition conditional on the row still being in flight.
	return transaction
		.update(moderationActions)
		.set(set)
		.where(and(
			inArray(moderationActions.commentId, actions.map((action) => action.commentId)),
			inArray(moderationActions.state, fromStates)
		));
}

/**
 * Transitions outstanding action rows inside the channel-guard transaction.
 * The 'dispatched' transition stamps lastAttemptAt; terminal transitions
 * leave attempt bookkeeping untouched.
 */
async function transitionActions(
	actions: OutstandingAction[],
	set: { state: 'dispatched' | 'superseded'; lastAttemptAt?: string },
	expected?: ChannelIdentity,
	fromStates?: OutstandingState[]
) {
	// Stryker disable next-line ConditionalExpression: equivalent — removing the guard makes an empty batch run a no-op update; observably identical (dispatch callers always pass ≥1, markSuperseded passes an empty partition)
	if (!actions.length) return;
	await db.transaction(async (transaction) => {
		await assertChannelActive(actions[0].channelId, transaction, expected);
		await updateActionStates(transaction, actions, set, fromStates);
	});
}

function markDispatched(actions: OutstandingAction[], expected?: ChannelIdentity) {
	return transitionActions(actions, { state: 'dispatched', lastAttemptAt: new Date().toISOString() }, expected);
}

async function claimPendingActions(actions: OutstandingAction[], expected?: ChannelIdentity): Promise<Set<string>> {
	if (!actions.length) return new Set();
	return db.transaction(async (transaction) => {
		await assertChannelActive(actions[0].channelId, transaction, expected);
		const claimed = await transaction
			.update(moderationActions)
			.set({ state: 'dispatched' })
			.where(and(
				inArray(moderationActions.commentId, actions.map((action) => action.commentId)),
				eq(moderationActions.state, 'pending')
			))
			.returning({ commentId: moderationActions.commentId });
		return new Set(claimed.map((row) => row.commentId));
	});
}

/**
 * A human decision supersedes a staged 'hold' it raced with: the queue claims
 * the comment (status leaves 'pending'), so the hold must never be applied
 * after the fact. 'superseded' is a terminal state — no completion audit row,
 * because the hold never reached YouTube (the 'queue' row already records why
 * the comment was ever queued).
 *
 * The comment status is re-read INSIDE this transaction: partitionHolds ran
 * earlier without a lock, and a failed human action can restore the comment
 * to 'pending' in between — superseding then would strand it (public on
 * YouTube while the queue calls it held, nothing retrying the hold).
 */
async function markSuperseded(actions: OutstandingAction[], expected?: ChannelIdentity) {
	if (!actions.length) return;
	await db.transaction(async (transaction) => {
		await assertChannelActive(actions[0].channelId, transaction, expected);
		const rows = await transaction
			.select({ id: comments.id, status: comments.status })
			.from(comments)
			.where(inArray(comments.id, actions.map((action) => action.commentId)))
			.all();
		const decided = new Set(
			rows.filter((row) => row.status !== 'pending' && row.status !== 'held').map((row) => row.id)
		);
		const still = actions.filter((action) => decided.has(action.commentId));
		if (still.length) await updateActionStates(transaction, still, { state: 'superseded' });
	});
}

/**
 * Splits a hold batch into actions that still apply and ones a human decision
 * already superseded. 'pending' means the comment still waits for review and
 * 'held' a rule's standing hold — both still want the remote hold. Anything
 * else (approved/rejected/deleted by a human or rule, a restore in flight, or
 * a comment row gone) means the comment's fate is decided: holding it now
 * would re-hide a comment a human already judged.
 */
async function partitionHolds(actions: OutstandingAction[]): Promise<{ applicable: OutstandingAction[]; superseded: OutstandingAction[] }> {
	const rows = await db
		.select({ id: comments.id, status: comments.status })
		.from(comments)
		.where(inArray(comments.id, actions.map((action) => action.commentId)))
		.all();
	const statusById = new Map(rows.map((row) => [row.id, row.status]));
	const applicable: OutstandingAction[] = [];
	const superseded: OutstandingAction[] = [];
	for (const action of actions) {
		const status = statusById.get(action.commentId);
		if (status === 'pending' || status === 'held') applicable.push(action);
		else superseded.push(action);
	}
	return { applicable, superseded };
}

/**
 * A hold's remote 'heldForReview' state must not outlive the comment's local
 * decision: a dispatched write can land after a rescan approval or a human
 * action already committed (codex), leaving YouTube hiding a comment local
 * data calls approved — with the row terminal, nothing would reconcile it.
 * Before a hold goes terminal, re-apply the decided state: 'approved' →
 * publish, 'rejected' → reject, 'deleted' → delete. 'pending'/'held' still
 * want the hold and 'restoring' is reconverged by the reconcile sweep
 * replaying the recorded human intent, so neither needs a write here.
 *
 * Returns the comment ids safe to terminalize. A failed corrective write or
 * a missing comment row keeps its action outstanding so the next sweep
 * retries instead of recording a terminal state over diverged remote truth.
 */
const DECIDED_INTENT: Record<string, 'approve' | 'reject' | 'delete'> = {
	approved: 'approve',
	rejected: 'reject',
	deleted: 'delete'
};

/** The remote outcome each queued action drives toward. */
const ACTION_OUTCOME: Record<YoutubeAction, 'held' | 'rejected' | 'deleted'> = {
	hold: 'held',
	reject: 'rejected',
	ban: 'rejected',
	delete: 'deleted'
};

/**
 * Comment statuses carrying their own remote truth: every decided status a
 * corrective write can re-assert (DECIDED_INTENT) plus 'restoring', which
 * the human flow owns end-to-end. A resolved action write whose outcome
 * conflicts with one of these cannot prove its ordering against the
 * decision's own write — the row must stay outstanding so the next sweep's
 * corrective write lands LAST. 'pending'/'held' still want the queued
 * action's outcome and a missing row has nothing to converge, so neither
 * contests completion.
 */
const CONTESTED_STATUSES = new Set(['approved', 'rejected', 'deleted', 'restoring']);

/** The decided intent a comment's current status re-asserts, if any. */
function decidedIntentFor(status: string | undefined, mayHaveLanded: boolean): 'approve' | 'reject' | 'delete' | undefined {
	return status === undefined || !mayHaveLanded ? undefined : DECIDED_INTENT[status];
}

async function convergeHolds(
	actions: OutstandingAction[],
	accessToken: string,
	deadline: number | undefined,
	expected?: ChannelIdentity,
	applied = false
): Promise<Set<string>> {
	const converged = new Set<string>();
	if (!actions.length) return converged;
	const rows = await db
		.select({ id: comments.id, status: comments.status })
		.from(comments)
		.where(inArray(comments.id, actions.map((action) => action.commentId)))
		.all();
	const statusById = new Map(rows.map((row) => [row.id, row.status]));
	for (const action of actions) {
		const status = statusById.get(action.commentId);
		// A row that was only ever 'pending' never reached YouTube — the
		// deciding path already wrote remotely, so nothing needs re-applying.
		const intent = decidedIntentFor(status, applied || action.state !== 'pending');
		if (!intent) {
			// 'restoring' belongs to the human flow: reconcile replays the
			// recorded intent and finalizeHumanIntent commits the decided
			// status AND terminalizes this row. Converging here would mark it
			// done while our remote write can still lose the ordering race
			// with the human's — nothing would repair that (codex).
			if (status !== undefined && status !== 'restoring') converged.add(action.commentId);
			continue;
		}
		try {
			if (await convergeOneHold(action, status, intent, accessToken, deadline, expected)) converged.add(action.commentId);
		} catch (error) {
			if (error instanceof DeadlineExceededError || error instanceof ChannelDeactivatedError) throw error;
			// Loud per-item failure (I1): the row stays outstanding so a later
			// sweep re-attempts the corrective write.
			console.warn('remote convergence failed for comment %s (status %s)', action.commentId, status, error);
		}
	}
	return converged;
}

/**
 * Applies one corrective write and proves its ordering: the comment's local
 * status is re-read after the remote call because a concurrent decider moving
 * it mid-write makes ordering unprovable (codex).
 *
 * @returns `true` when the action's comment converged to its real outcome.
 */
async function convergeOneHold(
	action: OutstandingAction,
	status: string | undefined,
	intent: 'approve' | 'reject' | 'delete',
	accessToken: string,
	deadline: number | undefined,
	expected?: ChannelIdentity
): Promise<boolean> {
	await assertChannelActive(action.channelId, db, expected);
	if (status === undefined) return false;
	const dispatch = await reserveDecidedDispatch(action.channelId, action.commentId, status, expected);
	if (!dispatch) return false;
	const outcome = await executeDecidedDispatch(dispatch, intent, accessToken, expected, deadline);
	if (outcome === 'missing' && intent !== 'delete') {
		// The corrective write 404'd: YouTube has no comment to publish
		// or reject — a dispatched delete already landed (or the owner
		// removed it) before this verdict. 'approved'/'rejected' can
		// never be true remotely, so the local row converges to the
		// REAL outcome ('deleted') instead of superseding the action
		// over a local-approved/remote-deleted lie (codex). The
		// status guard keeps a mid-flight 'restoring' claim owned by
		// the human flow — no match leaves the action outstanding.
		const flipped = await db
			.update(comments)
			.set({ status: 'deleted' })
			.where(and(eq(comments.id, action.commentId), inArray(comments.status, ['approved', 'rejected'])))
			.returning({ id: comments.id });
		return flipped.length > 0;
	}
	// The corrective write landed — but the status this loop read was
	// taken BEFORE it. A concurrent decider moving the comment while
	// the write was in flight (a 'restoring' claim, or a rescan's fresh
	// verdict) makes its ordering unprovable: terminalizing here leaves
	// remote truth diverged with nothing outstanding to reconcile it
	// (codex). A changed status keeps the row 'cancelling' so the next
	// sweep converges the CURRENT decision; a vanished row has nothing
	// left to protect, so it still converges.
	const current = await db
		.select({ status: comments.status })
		.from(comments)
		.where(inArray(comments.id, [action.commentId]))
		.all();
	if (current[0] !== undefined && current[0].status !== status) {
		console.warn(
			'convergence for comment %s superseded mid-write (status %s → %s) — action stays outstanding',
			action.commentId,
			status,
			current[0].status
		);
		return false;
	}
	return true;
}

async function completeActions(actions: OutstandingAction[], expected?: ChannelIdentity): Promise<number> {
	// Stryker disable next-line ConditionalExpression: equivalent — all callers pass a non-empty array (applied batches or individually missing comments)
	if (!actions.length) return 0;
	let completed = 0;
	await db.transaction(async (transaction) => {
		await assertChannelActive(actions[0].channelId, transaction, expected);
		// The remote write resolved — but a comment whose local decision moved
		// while it was in flight makes ordering unprovable: the write may land
		// remotely AFTER the decision's own write. Completing the row would
		// record a terminal state over potentially diverged remote truth —
		// keep it 'cancelling' so the next sweep's corrective write lands
		// last (codex).
		const statuses = new Map(
			(await transaction
				.select({ id: comments.id, status: comments.status })
				.from(comments)
				.where(inArray(comments.id, actions.map((action) => action.commentId)))
				.all()).map((row) => [row.id, row.status] as const)
		);
		const matching = actions.filter((action) => {
			const status = statuses.get(action.commentId);
			return status === undefined || !CONTESTED_STATUSES.has(status) || status === ACTION_OUTCOME[action.action];
		});
		const contested = actions.filter((action) => !matching.includes(action));
		// Audit only rows this transaction actually completed: a concurrent
		// decider may have superseded one between the remote call and now —
		// writing its 'hold'/'reject' audit row would record a remote action
		// that never landed.
		const transitioned = matching.length
			? await transaction
					.update(moderationActions)
					.set({ state: 'completed' })
					.where(and(
						inArray(moderationActions.commentId, matching.map((action) => action.commentId)),
						inArray(moderationActions.state, ['pending', 'dispatched', 'cancelling'])
					))
					.returning({ commentId: moderationActions.commentId })
			: [];
		if (contested.length) {
			await transaction
				.update(moderationActions)
				.set({ state: 'cancelling' })
				.where(and(
					inArray(moderationActions.commentId, contested.map((action) => action.commentId)),
					inArray(moderationActions.state, ['pending', 'dispatched', 'cancelling'])
				));
		}
		const done = new Set(transitioned.map((row) => row.commentId));
		const finished = actions.filter((action) => done.has(action.commentId));
		completed = transitioned.length;
		if (!finished.length) return;
		await transaction.insert(auditLog).values(finished.map((action) => ({
			channelId: action.channelId,
			commentId: action.commentId,
			action: action.action,
			reason: action.reason,
			actor: 'system',
			// Staged at decision time (rows predating migration 0021, or erased
			// by the retention sweep, carry NULL — written through as NULL).
			authorHandle: action.authorHandle ?? null,
			createdAt: new Date().toISOString()
		})));
	});
	return completed;
}

function warnMissingComment(commentId: string, action: string): void {
	console.warn(`comment ${commentId} no longer exists on YouTube — completing ${action}`);
}

async function completeMissingAction(action: OutstandingAction, expected?: ChannelIdentity): Promise<void> {
	warnMissingComment(action.commentId, action.action);
	await completeActions([action], expected);
}

async function applyOneModerationAction(
	action: OutstandingAction,
	status: 'heldForReview' | 'rejected',
	banAuthor: boolean,
	accessToken: string,
	deadline: number | undefined,
	expected?: ChannelIdentity
): Promise<boolean> {
	assertBeforeDeadline(deadline);
	await assertChannelActive(action.channelId, db, expected);
	try {
		await setModerationStatus([action.commentId], status, banAuthor, accessToken, deadline);
	} catch (error) {
		if (!(error instanceof CommentNotFoundError)) throw error;
		await completeMissingAction(action, expected);
		return false;
	}
	if (status === 'heldForReview') {
		const converged = await convergeHolds([action], accessToken, deadline, expected, true);
		// The remote write landed but the row stays outstanding (a failed
		// corrective write or a restoring claim) — it is not "acted" until a
		// later sweep terminalizes it (codex).
		if (!converged.has(action.commentId)) return false;
	}
	return (await completeActions([action], expected)) > 0;
}

async function applyModerationAction(
	actions: OutstandingAction[],
	status: 'heldForReview' | 'rejected',
	banAuthor: boolean,
	accessToken: string,
	deadline: number | undefined,
	expected?: ChannelIdentity
): Promise<number> {
	let acted = 0;
	for (let index = 0; index < actions.length; index += YOUTUBE_ID_BATCH_SIZE) {
		const batch = actions.slice(index, index + YOUTUBE_ID_BATCH_SIZE);
		await markDispatched(batch, expected);
		assertBeforeDeadline(deadline);
		await assertChannelActive(batch[0].channelId, db, expected);
		// A hold stays provisional until applied: a human decision recorded in
		// comments wins this database-only race before the YouTube write.
		const { applicable, superseded } = status === 'heldForReview'
			? await partitionHolds(batch)
			: { applicable: batch, superseded: [] };
		// A superseded hold may have been dispatched before a crash and already
		// landed remotely — converge the decided state before terminalizing.
		const releasable = await convergeHolds(superseded, accessToken, deadline, expected);
		await markSuperseded(superseded.filter((action) => releasable.has(action.commentId)), expected);
		if (!applicable.length) continue;
		acted += await applyModerationBatch(applicable, status, banAuthor, accessToken, deadline, expected);
	}
	return acted;
}

/**
 * Applies one batched YouTube moderation write, then terminalizes the rows
 * whose outcome is provable. A batch 404 falls back to per-action handling;
 * a hold write is provisional until its post-write convergence check proves
 * no human decision landed mid-flight.
 */
async function applyModerationBatch(
	applicable: OutstandingAction[],
	status: 'heldForReview' | 'rejected',
	banAuthor: boolean,
	accessToken: string,
	deadline: number | undefined,
	expected?: ChannelIdentity
): Promise<number> {
	try {
		await setModerationStatus(applicable.map((action) => action.commentId), status, banAuthor, accessToken, deadline);
	} catch (error) {
		if (!(error instanceof CommentNotFoundError)) throw error;
		if (applicable.length === 1) {
			await completeMissingAction(applicable[0], expected);
			return 0;
		}
		let acted = 0;
		for (const action of applicable) {
			if (await applyOneModerationAction(action, status, banAuthor, accessToken, deadline, expected)) acted += 1;
		}
		return acted;
	}
	// The hold write resolved — but a human decision committed while it was
	// in flight needs its state written last, or the late hold wins remotely.
	const finished = status === 'heldForReview'
		? await convergeHolds(applicable, accessToken, deadline, expected, true)
		: new Set(applicable.map((action) => action.commentId));
	// Count only rows this run actually terminalized — a hold whose
	// corrective write failed stays outstanding and counts when a later
	// sweep completes it (codex).
	return completeActions(applicable.filter((action) => finished.has(action.commentId)), expected);
}

async function applyYoutubeActions(
	actions: OutstandingAction[],
	accessToken: string,
	deadline: number | undefined,
	expected?: ChannelIdentity
): Promise<number> {
	const selected = (action: YoutubeAction) => actions.filter((item) => item.action === action);
	let acted = 0;
	acted += await applyModerationAction(selected('hold'), 'heldForReview', false, accessToken, deadline, expected);
	acted += await applyModerationAction(selected('reject'), 'rejected', false, accessToken, deadline, expected);
	acted += await applyModerationAction(selected('ban'), 'rejected', true, accessToken, deadline, expected);
	acted += await applyDeletes(selected('delete'), accessToken, deadline, expected);
	return acted;
}

/** Dispatches, deletes, and completes a batch of delete actions (I3/I4-safe). */
async function applyDeletes(actions: OutstandingAction[], accessToken: string, deadline: number | undefined, expected?: ChannelIdentity): Promise<number> {
	let acted = 0;
	for (const action of actions) {
		await markDispatched([action], expected);
		assertBeforeDeadline(deadline);
		await assertChannelActive(action.channelId, db, expected);
		await deleteComment(action.commentId, accessToken, deadline);
		acted += await completeActions([action], expected);
	}
	return acted;
}

async function processOutstandingActions(channelId: string, accessToken: string, deadline?: number, expected?: ChannelIdentity): Promise<number> {
	const actions = (await db
		.select()
		.from(moderationActions)
		.where(and(
			eq(moderationActions.channelId, channelId),
			inArray(moderationActions.state, ['pending', 'dispatched', 'cancelling'])
		))
		.all()).map(outstandingAction);
	// Human claims and unresolved corrective writes own their comment.
	// A rescan may change its local status, but no newer staged enforcement
	// can bypass the durable reservation while an older write may land.
	const restoringIds = actions.length
		? (
				await db
					.select({ id: comments.id })
					.from(comments)
					.where(and(eq(comments.channelId, channelId), or(eq(comments.status, 'restoring'),
						isNotNull(comments.humanDispatchToken), isNotNull(comments.humanDispatchState))))
					.all()
			).map((row) => row.id)
		: [];
	const restoring = new Set(restoringIds);
	const cancelling = actions.filter((action) => action.state === 'cancelling' && !restoring.has(action.commentId));
	// A cancelled action may already be live on YouTube — holds AND
	// reject/ban/delete alike: converge the remote state (re-write the
	// comment's decided status) before the row goes terminal, or a
	// rescan-approved comment stays hidden with nothing reconciling it
	// (codex).
	const convergedCancels = await convergeHolds(cancelling, accessToken, deadline, expected);
	const releasable = cancelling.filter((action) => convergedCancels.has(action.commentId));
	await transitionActions(releasable, { state: 'superseded' }, expected, ['cancelling']);
	// Stryker disable next-line MethodExpression, ConditionalExpression: equivalent — claimPendingActions' SQL still guards eq(state, 'pending'), so handing it dispatched rows too claims nothing extra
	const claimed = await claimPendingActions(actions.filter((action) => action.state === 'pending' && !restoring.has(action.commentId)), expected);
	// Stryker disable next-line ArrayDeclaration: equivalent — applyYoutubeActions selects entries by their action field, so a foreign element in the array is never selected
	const ready: OutstandingAction[] = [];
	for (const action of actions) {
		if (restoring.has(action.commentId)) continue;
		if (action.state === 'dispatched') {
			ready.push(action);
			continue;
		}
		if (action.state === 'pending') {
			// Only actions this run claimed may be applied; an empty claim means a
			// concurrent run owns the action, so skip it to avoid duplicate
			// enforcement. The in-memory 'pending' is kept: convergeHolds reads it
			// to know the row never reached YouTube before this run.
			if (claimed.has(action.commentId)) ready.push(action);
		}
	}
	return applyYoutubeActions(ready, accessToken, deadline, expected);
}

/**
 * The local status committed after applying a human intent. 'restore' is the
 * audit-log undo verb. Unknown actions return null rather than guessing.
 */
export function humanFinalStatus(action: string): 'approved' | 'deleted' | 'rejected' | null {
	if (action === 'approve' || action === 'restore') return 'approved';
	if (action === 'delete') return 'deleted';
	if (action === 'reject' || action === 'ban') return 'rejected';
	return null;
}

/**
 * Applies one idempotent YouTube write for a recorded human intent.
 * 'missing' means YouTube reports the comment gone — a publish/reject
 * corrective can never land, so the real remote outcome is 'deleted'
 * whatever the intent asked. Callers converge or finalize THAT truth
 * rather than stamping the requested status over a remote deletion
 * (codex).
 */
export async function applyHumanIntent(
	commentId: string,
	action: string,
	accessToken: string,
	deadline?: number
): Promise<'applied' | 'missing'> {
	if (!humanFinalStatus(action)) throw new Error(`unsupported human intent '${action}'`);
	try { assertBeforeDeadline(deadline); } catch (cause) { throw new RequestNotSentError(cause); }
	try {
		if (action === 'approve' || action === 'restore') {
			await setModerationStatus([commentId], 'published', false, accessToken, deadline, true);
		} else if (action === 'reject' || action === 'ban') {
			await setModerationStatus([commentId], 'rejected', action === 'ban', accessToken, deadline, true);
		} else {
			await deleteComment(commentId, accessToken, deadline, true);
		}
	} catch (error) {
		if (!(error instanceof CommentNotFoundError)) throw error;
		warnMissingComment(commentId, action);
		return 'missing';
	}
	return 'applied';
}

/**
 * Commits the local result of a human intent in ONE transaction: the final
 * comment status is guarded on 'restoring' and the exact intent ID, and every outstanding action row
 * for the comment is resolved by whether its remote outcome AGREES with the
 * human's. A dispatched row whose outcome equals the final status completes
 * and is audited — both writes land the same remote state either order. A
 * CONFLICTING dispatched row may still have its write in flight: completing
 * it would claim it landed before the human's write, which cannot be proven
 * — it stays 'cancelling' so the next sweep's corrective write is guaranteed
 * to land last (codex). A pending row never reached YouTube and supersedes;
 * a cancelling row supersedes only when its outcome agrees, else its
 * corrective write stays outstanding for the same in-flight reason.
 */
export async function finalizeHumanIntent(
	channelId: string,
	commentId: string,
	action: string,
	intentId: number,
	expected?: ChannelIdentity,
	dispatchToken?: string
): Promise<boolean> {
	const status = humanFinalStatus(action);
	if (!status) throw new Error(`unsupported human intent '${action}'`);
	const agreeing = (Object.keys(ACTION_OUTCOME) as YoutubeAction[]).filter((verb) => ACTION_OUTCOME[verb] === status);
	return db.transaction(async (transaction) => {
		await assertChannelActive(channelId, transaction, expected);
		const claimed = await transaction
			.update(comments)
			.set({ status, decidedBy: 'human', restoreIntentId: null, humanDispatchToken: null, humanDispatchState: null })
			.where(and(
				eq(comments.id, commentId),
				eq(comments.channelId, channelId),
				eq(comments.status, 'restoring'),
				eq(comments.restoreIntentId, intentId),
				dispatchToken ? eq(comments.humanDispatchToken, dispatchToken) : isNull(comments.humanDispatchToken),
				dispatchToken ? eq(comments.humanDispatchState, 'in_flight') : isNull(comments.humanDispatchState)
			))
			.returning({ id: comments.id });
		if (!claimed.length) {
			const current = await transaction
				.select({ status: comments.status, humanDispatchToken: comments.humanDispatchToken, humanDispatchState: comments.humanDispatchState })
				.from(comments)
				.where(inArray(comments.id, [commentId]))
				.all();
			if ((current[0]?.humanDispatchToken || current[0]?.humanDispatchState) &&
				(current[0].humanDispatchToken !== dispatchToken || current[0].humanDispatchState !== 'in_flight')) {
				console.warn('finalize: comment %s has a different dispatch owner — leaving its claim unchanged', commentId);
				return false;
			}
			if (current[0] && current[0].status !== status) {
				await transaction
					.update(moderationActions)
					.set({ state: current[0].status === 'pending' || current[0].status === 'held' ? 'pending' : 'cancelling' })
					.where(and(eq(moderationActions.commentId, commentId), eq(moderationActions.state, 'completed')));
			}
			console.warn('finalize: comment %s left restoring mid-flight — conflicting completed actions re-armed for reconciliation', commentId);
			return false;
		}
		const dispatched = agreeing.length
			? await transaction
					.update(moderationActions)
					.set({ state: 'completed' })
					.where(and(
						eq(moderationActions.commentId, commentId),
						eq(moderationActions.state, 'dispatched'),
						inArray(moderationActions.action, agreeing)
					))
					.returning({ action: moderationActions.action, reason: moderationActions.reason, authorHandle: moderationActions.authorHandle })
			: [];
		// Dispatched rows still here disagree with the human outcome — keep
		// them outstanding until a corrective write lands last.
		await transaction
			.update(moderationActions)
			.set({ state: 'cancelling' })
			.where(and(eq(moderationActions.commentId, commentId), eq(moderationActions.state, 'dispatched')));
		await transaction
			.update(moderationActions)
			.set({ state: 'superseded' })
			.where(and(eq(moderationActions.commentId, commentId), eq(moderationActions.state, 'pending')));
		if (agreeing.length) {
			await transaction
				.update(moderationActions)
				.set({ state: 'superseded' })
				.where(and(
					eq(moderationActions.commentId, commentId),
					eq(moderationActions.state, 'cancelling'),
					inArray(moderationActions.action, agreeing)
				));
		}
		if (dispatched.length) {
			await transaction.insert(auditLog).values(
				dispatched.map((row) => ({
					channelId,
					commentId,
					action: row.action,
					reason: row.reason,
					actor: 'system',
					authorHandle: row.authorHandle ?? null,
					createdAt: new Date().toISOString()
				}))
			);
		}
		return true;
	});
}

/** Reads only the audit bound to this claim, never a historical fallback. */
export async function claimedHumanIntent(
	channelId: string,
	commentId: string,
	intentId: number | null,
	handle: Pick<typeof db, 'select'> = db
) {
	if (intentId === null) return undefined;
	const intent = await handle
		.select({ id: auditLog.id, action: auditLog.action, actor: auditLog.actor })
		.from(auditLog)
		.where(and(
			eq(auditLog.id, intentId),
			eq(auditLog.channelId, channelId),
			eq(auditLog.commentId, commentId),
			eq(auditLog.actor, 'user')
		))
		.get();
	return intent && intent.actor === 'user' && humanFinalStatus(intent.action) ? intent : undefined;
}

/**
 * A restoring claim and its exact audit ID commit together before remote
 * work (I3). Only that audit is replayable. Legacy or invalid bindings stay
 * untouched until the owner explicitly retries; history cannot prove intent.
 */
async function reconcileRestoring(channelId: string, accessToken: string, deadline?: number, expected?: ChannelIdentity) {
	const stuck = await db
		.select({ id: comments.id, restoreIntentId: comments.restoreIntentId })
		.from(comments)
		.where(and(eq(comments.channelId, channelId), eq(comments.status, 'restoring')))
		.all();
	for (const row of stuck) {
		const intent = await claimedHumanIntent(channelId, row.id, row.restoreIntentId);
		if (!intent) {
			console.warn('reconcile: comment %s has no valid bound human intent — leaving restoring unchanged; owner retry required', row.id);
			continue;
		}
		try {
			// Outstanding actions and earlier restores may have taken time since
			// runEnforcement's connector check. Never spend a detached grant.
			await assertChannelActive(channelId, db, expected);
			// Intent lookup can race a request releasing or finishing this claim.
			// Re-read its exact binding immediately before remote dispatch; the
			// initial restoring snapshot is not authority for a replaced row.
			const [current] = await db.select({ status: comments.status, restoreIntentId: comments.restoreIntentId })
				.from(comments).where(and(eq(comments.id, row.id), eq(comments.channelId, channelId))).all();
			if (!current || current.status !== 'restoring' || current.restoreIntentId !== intent.id) {
				console.warn('reconcile: comment %s changed before human-intent dispatch — skipping stale claim', row.id);
				continue;
			}
			assertBeforeDeadline(deadline);
			const dispatch = await reserveHumanDispatch(channelId, row.id, intent.id, expected);
			if (!dispatch) {
				console.warn('reconcile: comment %s has an active or uncertain human write — automatic replay is paused', row.id);
				continue;
			}
			await executeHumanDispatch(dispatch, intent.action, accessToken, expected, deadline);
		} catch (error) {
			if (error instanceof DeadlineExceededError) throw error;
			console.error(
				`reconcile: could not finish '${intent.action}' for comment ${row.id}: ${error instanceof Error ? error.message : String(error)} — retrying next run`
			);
		}
	}
}

export async function runEnforcement(
	channelId: string,
	accessToken: string,
	deadline: number | undefined,
	orgId: string | null | undefined,
	deferred: number,
	expected?: ChannelIdentity
): Promise<{ acted: number; outOfCredits: boolean }> {
	// ... and again before any YouTube enforcement call.
	await assertChannelActive(channelId, db, expected);
	const acted = await processOutstandingActions(channelId, accessToken, deadline, expected);
	await reconcileRestoring(channelId, accessToken, deadline, expected);
	if (orgId) {
		await assertChannelActive(channelId, db, expected);
		try {
			await maybeTriggerAutoTopUp(orgId);
		} catch (error) {
			console.error(`auto top-up trigger failed for org ${orgId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (deferred > 0) {
		console.error(
			`out of credits for org ${orgId ?? '(none)'}: ${deferred} comment(s) deferred — AI scoring paused until credits are topped up`
		);
		return { acted, outOfCredits: true };
	}
	return { acted, outOfCredits: false };
}
