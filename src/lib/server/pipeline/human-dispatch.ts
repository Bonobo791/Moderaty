import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withBusyRetry } from '$lib/server/db';
import { comments } from '$lib/server/db/schema';
import { assertBeforeDeadline } from '$lib/server/http';
import { YoutubeWriteRefusedError } from '$lib/server/youtube';
import { applyHumanIntent, assertChannelActive, finalizeHumanIntent, type ChannelIdentity } from './enforcement';

export const HUMAN_DISPATCH_BLOCKED = 'This action is already in progress or its YouTube outcome is uncertain. Check the audit log before retrying.';
export const HUMAN_DISPATCH_UNCERTAIN = 'YouTube did not confirm the action. Your request is saved, and further actions are paused to avoid overwriting it. Check the audit log and contact support.';

export class HumanDispatchChangedError extends Error {}
export class HumanDispatchUncertainError extends Error {}
export class HumanFinalizeError extends Error {}

export interface HumanDispatch {
	channelId: string;
	commentId: string;
	intentId: number | null;
	status: string;
	token: string;
}

/**
 * One durable owner covers the provider call AND its local finalization.
 * Never expire this reservation: a timeout/crash cannot prove YouTube stopped
 * the write, and a later intent must not race a still-live earlier request.
 */
export async function reserveHumanDispatch(channelId: string, commentId: string, intentId: number, expected?: ChannelIdentity): Promise<HumanDispatch | null> {
	return reserveCommentDispatch(channelId, commentId, 'restoring', intentId, expected);
}

export async function reserveDecidedDispatch(channelId: string, commentId: string, status: string, expected?: ChannelIdentity): Promise<HumanDispatch | null> {
	const [current] = await db.select({ restoreIntentId: comments.restoreIntentId }).from(comments)
		.where(and(eq(comments.channelId, channelId), eq(comments.id, commentId), eq(comments.status, status))).all();
	if (!current) return null;
	// A rescan can leave the old binding on a decided row. Fence its stored
	// value without replaying that audit: correction still follows status.
	return reserveCommentDispatch(channelId, commentId, status, current.restoreIntentId, expected);
}

async function reserveCommentDispatch(channelId: string, commentId: string, status: string, intentId: number | null, expected?: ChannelIdentity): Promise<HumanDispatch | null> {
	const token = randomUUID();
	const claimed = await withBusyRetry(() => db.transaction(async (transaction) => {
		await assertChannelActive(channelId, transaction, expected);
		return transaction.update(comments).set({ humanDispatchToken: token, humanDispatchState: 'in_flight' })
			.where(and(eq(comments.channelId, channelId), eq(comments.id, commentId), eq(comments.status, status),
				intentId === null ? isNull(comments.restoreIntentId) : eq(comments.restoreIntentId, intentId), isNull(comments.humanDispatchToken), isNull(comments.humanDispatchState)))
			.returning({ id: comments.id });
	}));
	return claimed.length ? { channelId, commentId, intentId, status, token } : null;
}

/** Release only a known settled attempt; uncertainty keeps its owner forever. */
async function settleHumanDispatch(claim: HumanDispatch, uncertain: boolean) {
	await db.update(comments).set({ humanDispatchToken: uncertain ? claim.token : null, humanDispatchState: uncertain ? 'uncertain' : null })
		.where(and(eq(comments.channelId, claim.channelId), eq(comments.id, claim.commentId),
			eq(comments.humanDispatchToken, claim.token), eq(comments.humanDispatchState, 'in_flight')));
}

/** Dispatch once, retaining ambiguous outcomes and fencing the finalizer. */
async function dispatchOnce(claim: HumanDispatch, action: string, accessToken: string, expected?: ChannelIdentity, deadline?: number): Promise<'applied' | 'missing'> {
	try {
		await assertChannelActive(claim.channelId, db, expected);
		const [current] = await db.select({ status: comments.status, restoreIntentId: comments.restoreIntentId, humanDispatchToken: comments.humanDispatchToken, humanDispatchState: comments.humanDispatchState })
			.from(comments).where(and(eq(comments.channelId, claim.channelId), eq(comments.id, claim.commentId))).all();
		if (!current || current.status !== claim.status || current.restoreIntentId !== claim.intentId || current.humanDispatchToken !== claim.token || current.humanDispatchState !== 'in_flight') {
			throw new HumanDispatchChangedError('The pending action changed before its YouTube write.');
		}
		assertBeforeDeadline(deadline);
	} catch (cause) {
		// No provider request began, so this reservation can safely be retried.
		await settleHumanDispatch(claim, false);
		throw cause;
	}
	try {
		return await applyHumanIntent(claim.commentId, action, accessToken, deadline);
	} catch (cause) {
		const uncertain = !(cause instanceof YoutubeWriteRefusedError);
		await settleHumanDispatch(claim, uncertain);
		if (uncertain) throw new HumanDispatchUncertainError(HUMAN_DISPATCH_UNCERTAIN, { cause });
		throw cause;
	}
}

/** A corrective write also owns the comment until its single request settles. */
export async function executeDecidedDispatch(claim: HumanDispatch, action: string, accessToken: string, expected?: ChannelIdentity, deadline?: number): Promise<'applied' | 'missing'> {
	const outcome = await dispatchOnce(claim, action, accessToken, expected, deadline);
	await settleHumanDispatch(claim, false);
	return outcome;
}

export async function executeHumanDispatch(claim: HumanDispatch, action: string, accessToken: string, expected?: ChannelIdentity, deadline?: number): Promise<'applied' | 'missing'> {
	if (claim.intentId === null) throw new Error('human dispatch requires an exact intent binding');
	const outcome = await dispatchOnce(claim, action, accessToken, expected, deadline);
	try {
		const finalized = await finalizeHumanIntent(claim.channelId, claim.commentId, outcome === 'missing' ? 'delete' : action, claim.intentId, expected, claim.token);
		if (!finalized) throw new HumanDispatchChangedError('The pending action changed while the YouTube write was running.');
	} catch (cause) {
		// The single provider call settled successfully; replay is safe when
		// only the database commit failed. Retain the exact intent for cron.
		await settleHumanDispatch(claim, false);
		throw new HumanFinalizeError('The action reached YouTube but saving it failed; reconciliation will finish it.', { cause });
	}
	return outcome;
}
