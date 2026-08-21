// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; see LICENSE.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { maybeTriggerAutoTopUp } from '$lib/server/billing/autotopup';
import { db } from '$lib/server/db';
import { auditLog, channels, moderationActions } from '$lib/server/db/schema';
import { assertBeforeDeadline, DeadlineExceededError } from '$lib/server/http';
import {
	deleteComment,
	getCommentModerationStatus,
	setModerationStatus
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
	// Stryker disable next-line ConditionalExpression, BlockStatement: equivalent — the only caller queries with inArray(state, ['pending','dispatched']), so no other state can reach this guard
	if (action.state !== 'pending' && action.state !== 'dispatched') {
		// Stryker disable next-line StringLiteral: equivalent — unreachable for the same reason as the guard above
		throw new Error(`moderation action ${action.commentId} has invalid outstanding state: ${action.state}`);
	}
	return { ...action, action: validAction(action.action), state: action.state };
}

async function markDispatched(actions: OutstandingAction[], expected?: ChannelIdentity) {
	// Stryker disable next-line ConditionalExpression: equivalent — both callers pass a non-empty array (applyModerationAction batches of ≥1, the delete loop a single action), so the empty-array branch is unreachable
	if (!actions.length) return;
	await db.transaction(async (transaction) => {
		await assertChannelActive(actions[0].channelId, transaction, expected);
		await transaction
			.update(moderationActions)
			.set({ state: 'dispatched', lastAttemptAt: new Date().toISOString() })
			.where(inArray(moderationActions.commentId, actions.map((action) => action.commentId)));
	});
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

async function completeActions(actions: OutstandingAction[], expected?: ChannelIdentity) {
	// Stryker disable next-line ConditionalExpression: equivalent — all callers pass a non-empty array (applyModerationAction batches of ≥1, single verified or deleted actions)
	if (!actions.length) return;
	await db.transaction(async (transaction) => {
		await assertChannelActive(actions[0].channelId, transaction, expected);
		await transaction
			.update(moderationActions)
			.set({ state: 'completed' })
			.where(inArray(moderationActions.commentId, actions.map((action) => action.commentId)));
		await transaction.insert(auditLog).values(actions.map((action) => ({
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

async function verificationResult(
	action: OutstandingAction,
	accessToken: string,
	deadline: number | undefined,
	expected?: ChannelIdentity
): Promise<'completed' | 'retry'> {
	assertBeforeDeadline(deadline);
	await assertChannelActive(action.channelId, db, expected);
	const status = await getCommentModerationStatus(action.commentId, accessToken, deadline);
	// Stryker disable next-line StringLiteral: 'retry'→"" equivalent — the caller only compares result === 'completed', so every other string takes the identical retry path
	if (action.action === 'delete') return status === null ? 'completed' : 'retry';
	// Stryker disable next-line StringLiteral: 'retry'→"" equivalent — same reasoning as the delete branch above
	if (action.action === 'hold') return status === 'heldForReview' ? 'completed' : 'retry';
	// Stryker disable next-line StringLiteral: 'retry'→"" equivalent — same reasoning as the delete branch above
	if (action.action === 'reject') return status === 'rejected' ? 'completed' : 'retry';
	// Ban is a single atomic API call (reject + banAuthor), so a comment already
	// in a terminal state after dispatch means the call landed — complete it
	// rather than stranding the action in manual review.
	// Stryker disable next-line StringLiteral: 'retry'→"" equivalent — same reasoning as the delete branch above
	return status === 'rejected' || status === null ? 'completed' : 'retry';
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
	for (let index = 0; index < actions.length; index += 50) {
		const batch = actions.slice(index, index + 50);
		await markDispatched(batch, expected);
		assertBeforeDeadline(deadline);
		await assertChannelActive(batch[0].channelId, db, expected);
		await setModerationStatus(batch.map((action) => action.commentId), status, banAuthor, accessToken, deadline);
		await completeActions(batch, expected);
		acted += batch.length;
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
			inArray(moderationActions.state, ['pending', 'dispatched'])
		))
		.all()).map(outstandingAction);
	// Stryker disable next-line MethodExpression, ConditionalExpression: equivalent — claimPendingActions' SQL still guards eq(state, 'pending'), so handing it dispatched rows too claims nothing extra
	const claimed = await claimPendingActions(actions.filter((action) => action.state === 'pending'), expected);
	// Stryker disable next-line ArrayDeclaration: equivalent — applyYoutubeActions selects entries by their action field, so a foreign element in the array is never selected
	const ready: OutstandingAction[] = [];
	for (const action of actions) {
		if (action.state === 'pending') {
			// Only actions this run claimed may be applied; an empty claim means a
			// concurrent run owns the action, so skip it to avoid duplicate enforcement.
			// Stryker disable next-line StringLiteral: equivalent — a ready entry's state field is never read again; applyYoutubeActions groups by action only
			if (claimed.has(action.commentId)) ready.push({ ...action, state: 'dispatched' });
			continue;
		}
		if ((await verifyDispatchedAction(action, accessToken, deadline, expected)) === 'completed') {
			await completeActions([action], expected);
			continue;
		}
		ready.push(action);
	}
	return applyYoutubeActions(ready, accessToken, deadline, expected);
}

/**
 * Re-verifies a previously-dispatched action. Transient verification failures
 * must not strand the action: leave it 'dispatched' so the next run
 * re-verifies, and fail loudly (DeadlineExceededError still escapes).
 */
async function verifyDispatchedAction(action: OutstandingAction, accessToken: string, deadline: number | undefined, expected?: ChannelIdentity): Promise<'completed' | 'retry'> {
	try {
		return await verificationResult(action, accessToken, deadline, expected);
	} catch (error) {
		if (error instanceof DeadlineExceededError) throw error;
		throw new Error(
			`moderation action ${action.commentId} verification failed: ${error instanceof Error ? error.message : String(error)}`
		);
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
