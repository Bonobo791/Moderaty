import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { maybeTriggerAutoTopUp } from '$lib/server/billing/autotopup';
import { db } from '$lib/server/db';
import { auditLog, channels, comments, moderationActions } from '$lib/server/db/schema';
import { assertBeforeDeadline, DeadlineExceededError } from '$lib/server/http';
import {
	CommentNotFoundError,
	deleteComment,
	setModerationStatus,
	YOUTUBE_ID_BATCH_SIZE
} from '$lib/server/youtube';
import type { OutstandingAction, YoutubeAction } from './types';

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
	fromStates: ('pending' | 'dispatched' | 'cancelling')[] = ['pending', 'dispatched', 'cancelling']
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
	fromStates?: ('pending' | 'dispatched' | 'cancelling')[]
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

async function completeActions(actions: OutstandingAction[], expected?: ChannelIdentity) {
	// Stryker disable next-line ConditionalExpression: equivalent — all callers pass a non-empty array (applied batches or individually missing comments)
	if (!actions.length) return;
	await db.transaction(async (transaction) => {
		await assertChannelActive(actions[0].channelId, transaction, expected);
		// Audit only rows this transaction actually completed: a concurrent
		// decider may have superseded one between the remote call and now —
		// writing its 'hold'/'reject' audit row would record a remote action
		// that never landed.
		const transitioned = await transaction
			.update(moderationActions)
			.set({ state: 'completed' })
			.where(and(
				inArray(moderationActions.commentId, actions.map((action) => action.commentId)),
				inArray(moderationActions.state, ['pending', 'dispatched', 'cancelling'])
			))
			.returning({ commentId: moderationActions.commentId });
		const done = new Set(transitioned.map((row) => row.commentId));
		const finished = actions.filter((action) => done.has(action.commentId));
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
	await completeActions([action], expected);
	return true;
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
		await markSuperseded(superseded, expected);
		if (!applicable.length) continue;
		try {
			await setModerationStatus(applicable.map((action) => action.commentId), status, banAuthor, accessToken, deadline);
		} catch (error) {
			if (!(error instanceof CommentNotFoundError)) throw error;
			if (applicable.length === 1) {
				await completeMissingAction(applicable[0], expected);
				continue;
			}
			for (const action of applicable) {
				if (await applyOneModerationAction(action, status, banAuthor, accessToken, deadline, expected)) acted += 1;
			}
			continue;
		}
		await completeActions(applicable, expected);
		acted += applicable.length;
	}
	return acted;
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
		await completeActions([action], expected);
		acted += 1;
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
	const cancelling = actions.filter((action) => action.state === 'cancelling');
	await transitionActions(cancelling, { state: 'superseded' }, expected, ['cancelling']);
	for (const action of cancelling) {
		console.warn(
			`moderation action ${action.commentId} (${action.action}) was cancelled by a rescan after dispatch — YouTube may still reflect it; left unchanged until the user acts`
		);
	}
	// Stryker disable next-line MethodExpression, ConditionalExpression: equivalent — claimPendingActions' SQL still guards eq(state, 'pending'), so handing it dispatched rows too claims nothing extra
	const claimed = await claimPendingActions(actions.filter((action) => action.state === 'pending'), expected);
	// Stryker disable next-line ArrayDeclaration: equivalent — applyYoutubeActions selects entries by their action field, so a foreign element in the array is never selected
	const ready: OutstandingAction[] = [];
	for (const action of actions) {
		if (action.state === 'dispatched') {
			ready.push(action);
			continue;
		}
		if (action.state === 'pending') {
			// Only actions this run claimed may be applied; an empty claim means a
			// concurrent run owns the action, so skip it to avoid duplicate enforcement.
			// Stryker disable next-line StringLiteral: equivalent — a ready entry's state field is never read again; applyYoutubeActions groups by action only
			if (claimed.has(action.commentId)) ready.push({ ...action, state: 'dispatched' });
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

/** Applies one idempotent YouTube write for a recorded human intent. */
export async function applyHumanIntent(
	commentId: string,
	action: string,
	accessToken: string,
	deadline?: number
): Promise<void> {
	if (!humanFinalStatus(action)) throw new Error(`unsupported human intent '${action}'`);
	assertBeforeDeadline(deadline);
	try {
		if (action === 'approve' || action === 'restore') {
			await setModerationStatus([commentId], 'published', false, accessToken, deadline);
		} else if (action === 'reject' || action === 'ban') {
			await setModerationStatus([commentId], 'rejected', action === 'ban', accessToken, deadline);
		} else {
			await deleteComment(commentId, accessToken, deadline);
		}
	} catch (error) {
		if (!(error instanceof CommentNotFoundError)) throw error;
		warnMissingComment(commentId, action);
	}
}

/**
 * Commits the local result of a human intent in ONE transaction: the final
 * comment status is guarded on 'restoring', and hold bookkeeping is derived
 * from the action row. A dispatched hold is completed and audited; a pending
 * or cancelled hold is superseded without an audit row.
 */
export async function finalizeHumanIntent(
	channelId: string,
	commentId: string,
	action: string,
	expected?: ChannelIdentity
): Promise<void> {
	const status = humanFinalStatus(action);
	if (!status) throw new Error(`unsupported human intent '${action}'`);
	await db.transaction(async (transaction) => {
		await assertChannelActive(channelId, transaction, expected);
		await transaction
			.update(comments)
			.set({ status, decidedBy: 'human' })
			.where(and(eq(comments.id, commentId), eq(comments.status, 'restoring')));
		const dispatchedHold = await transaction
			.update(moderationActions)
			.set({ state: 'completed' })
			.where(and(
				eq(moderationActions.commentId, commentId),
				eq(moderationActions.action, 'hold'),
				eq(moderationActions.state, 'dispatched')
			))
			.returning({ reason: moderationActions.reason });
		await transaction
			.update(moderationActions)
			.set({ state: 'superseded' })
			.where(and(
				eq(moderationActions.commentId, commentId),
				eq(moderationActions.action, 'hold'),
				inArray(moderationActions.state, ['pending', 'cancelling'])
			));
		if (dispatchedHold.length) {
			await transaction.insert(auditLog).values(
				dispatchedHold.map((row) => ({
					channelId,
					commentId,
					action: 'hold',
					reason: row.reason,
					actor: 'system',
					authorHandle: null,
					createdAt: new Date().toISOString()
				}))
			);
		}
	});
}

/**
 * Human actions claim a comment into 'restoring' and record their intent as
 * an audit row BEFORE the remote call (I3). A crash leaves 'restoring' +
 * the intent row — this sweep re-executes the intent (every remote verb is
 * idempotent) and commits the final status, so a crashed action converges
 * instead of sitting invisible between states forever. A 'restoring' row
 * without a user intent audit is not ours to finish.
 */
async function reconcileRestoring(channelId: string, accessToken: string, deadline?: number, expected?: ChannelIdentity) {
	const stuck = await db
		.select({ id: comments.id })
		.from(comments)
		.where(and(eq(comments.channelId, channelId), eq(comments.status, 'restoring')))
		.all();
	for (const row of stuck) {
		const intent = await db
			.select({ action: auditLog.action, actor: auditLog.actor })
			.from(auditLog)
			.where(and(eq(auditLog.channelId, channelId), eq(auditLog.commentId, row.id)))
			.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
			.limit(1)
			.get();
		if (!intent || intent.actor !== 'user' || !humanFinalStatus(intent.action)) continue;
		try {
			assertBeforeDeadline(deadline);
			await applyHumanIntent(row.id, intent.action, accessToken, deadline);
			await finalizeHumanIntent(channelId, row.id, intent.action, expected);
		} catch (error) {
			if (error instanceof DeadlineExceededError) throw error;
			// Leave it 'restoring' for the next run — one stuck comment must
			// never abort the sweep or the run (I1), and never fail silently.
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
