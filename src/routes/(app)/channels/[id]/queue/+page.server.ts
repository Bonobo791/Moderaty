import { db, withBusyRetry } from '$lib/server/db';
import { comments, auditLog, moderationActions } from '$lib/server/db/schema';
import { and, eq, desc, isNull } from 'drizzle-orm';
import { refreshAccessToken } from '$lib/server/youtube';
import { assertChannelActive } from '$lib/server/pipeline/enforcement';
import { executeHumanDispatch, reserveHumanDispatch, HumanDispatchUncertainError, HumanFinalizeError, HUMAN_DISPATCH_BLOCKED, HUMAN_DISPATCH_UNCERTAIN } from '$lib/server/pipeline/human-dispatch';
import { decrypt } from '$lib/server/crypto';
import { ownedChannel } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';
import { env } from '$env/dynamic/private';
import { error, fail } from '@sveltejs/kit';

export async function load({ params, locals }) {
	// Database outage: the layout renders the overlay; this load must not 401
	// on the null-user outage shape.
	if (locals.dbDown) return { ch: { id: params.id, title: '' }, pending: [], maintenance: true };
	const ch = await ownedChannel(params.id, locals);
	// The hold's real state rides along: 'completed' means the comment is
	// actually hidden on YouTube; anything else means the hold was requested
	// but has not (or may not have) landed — the page says so honestly
	// instead of claiming every queued comment is already non-public.
	const pending = await db
		.select({
			id: comments.id,
			text: comments.text,
			publishedAt: comments.publishedAt,
			holdState: moderationActions.state,
			reason: moderationActions.reason
		})
		.from(comments)
		.leftJoin(
			moderationActions,
			and(eq(moderationActions.commentId, comments.id), eq(moderationActions.action, 'hold'))
		)
		.where(and(eq(comments.channelId, params.id), eq(comments.status, 'pending')))
		.orderBy(desc(comments.publishedAt))
		.limit(100)
		.all();
	// Project only what the page renders — never serialize refreshTokenEnc (or
	// any future secret column) or legacy author columns to the browser.
	return { ch: { id: ch.id, title: ch.title }, pending };
}

const SUCCESS_TEXT: Record<'approve' | 'reject' | 'delete' | 'ban', string> = {
	approve: 'Approved — recorded in audit log.',
	reject: 'Rejected — recorded in audit log.',
	delete: 'Deleted — recorded in audit log.',
	ban: 'Author banned — recorded in audit log.'
};

/** DB status for a human review action (no nested ternary — sonarcloud S3358). */
function statusForAction(action: string): 'approved' | 'deleted' | 'rejected' {
	if (action === 'approve') return 'approved';
	if (action === 'delete') return 'deleted';
	if (action === 'reject' || action === 'ban') return 'rejected';
	// Unsupported runtime values must never silently map to a moderation status.
	throw error(500, 'Unsupported moderation action');
}

async function act(paramsId: string, commentId: string, action: 'approve' | 'reject' | 'delete' | 'ban', locals: App.Locals) {
	const ch = await ownedChannel(paramsId, locals);
	const status = statusForAction(action);
	const dryRun = env.DRY_RUN === 'true';
	if (dryRun) {
		// No remote call in dry run: the final status and the dry-run audit
		// row commit atomically — nothing dangles between them.
		const claimed = await db.transaction(async (transaction) => {
			const rows = await transaction
				.update(comments)
				.set({ status, decidedBy: 'human' })
				.where(and(eq(comments.id, commentId), eq(comments.channelId, paramsId), eq(comments.status, 'pending'), isNull(comments.humanDispatchToken), isNull(comments.humanDispatchState)))
				.returning({ id: comments.id });
			if (!rows.length) return false;
			await transaction.insert(auditLog).values({
				channelId: paramsId,
				commentId,
				action: 'dry-run',
				reason: 'manual review',
				actor: 'user',
				// No handle source at manual-action time: comments.author_name is never persisted by design.
				authorHandle: null,
				createdAt: new Date().toISOString()
			});
			return true;
		});
		if (!claimed) throw error(404, 'pending comment not found in this channel');
		return { success: SUCCESS_TEXT[action] };
	}
	// Claim into 'restoring' and record the intent row in ONE transaction
	// (I3): concurrent submissions single-winner on the 'pending' predicate,
	// and a crash leaves durable intent the reconcile sweep re-executes —
	// never a decided comment with unapplied remote work.
	const claim = await withBusyRetry(() => db.transaction(async (transaction) => {
		const claimed = await transaction
			.update(comments)
			.set({ status: 'restoring', decidedBy: 'human' })
			.where(and(eq(comments.id, commentId), eq(comments.channelId, paramsId), eq(comments.status, 'pending'), isNull(comments.humanDispatchToken), isNull(comments.humanDispatchState)))
			.returning({ id: comments.id });
		if (claimed.length === 0) return null;
		const intent = await transaction
			.insert(auditLog)
			.values({
				channelId: paramsId,
				commentId,
				action,
				reason: 'manual review',
				actor: 'user',
				authorHandle: null,
				createdAt: new Date().toISOString()
			})
			.returning({ id: auditLog.id });
		await transaction.update(comments).set({ restoreIntentId: intent[0].id }).where(eq(comments.id, commentId));
		return { intentId: intent[0].id };
	}));
	if (!claim) throw error(404, 'pending comment not found in this channel');
	// 'missing' means YouTube reports the comment gone — the requested intent
	// can never be true remotely, so the honest outcome to finalize is
	// 'deleted', not the verb the user clicked (codex).
	let remoteMissing = false;
	try {
		// The channel snapshot was loaded before the claim — account deletion
		// can have detached it since. Revalidate the connector identity before
		// spending the grant. A failure before dispatch can release the claim.
		await assertChannelActive(paramsId, db, ch);
		const token = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
		const dispatch = await reserveHumanDispatch(paramsId, commentId, claim.intentId, ch);
		if (!dispatch) return fail(409, { error: HUMAN_DISPATCH_BLOCKED });
		remoteMissing = (await executeHumanDispatch(dispatch, action, token, ch)) === 'missing';
	} catch (e) {
		console.error('[queue] %s failed for comment %s', action, commentId, e);
		if (e instanceof HumanDispatchUncertainError) return fail(500, { error: HUMAN_DISPATCH_UNCERTAIN });
		if (e instanceof HumanFinalizeError) return fail(500, { error: 'The action reached YouTube but is still being recorded — it resolves automatically.' });
		// Only a known predispatch failure or settled refusal can release.
		// Another dispatcher may have reserved while token refresh yielded:
		// an owned/uncertain reservation must never be cleared here.
		const released = await db.transaction(async (transaction) => {
			const released = await transaction
				.update(comments)
				.set({ status: 'pending', decidedBy: 'none', restoreIntentId: null })
				.where(and(eq(comments.id, commentId), eq(comments.channelId, paramsId), eq(comments.status, 'restoring'), eq(comments.restoreIntentId, claim.intentId),
					isNull(comments.humanDispatchToken), isNull(comments.humanDispatchState)))
				.returning({ id: comments.id });
			if (!released.length) return false;
			await transaction.delete(auditLog).where(eq(auditLog.id, claim.intentId));
			await transaction
				.update(moderationActions)
				.set({ state: 'pending' })
				.where(
					and(
						eq(moderationActions.commentId, commentId),
						eq(moderationActions.action, 'hold'),
						eq(moderationActions.state, 'superseded')
					)
				);
			return true;
		});
		// Full error detail stays server-side; the client gets a generic
		// message in the error-box instead of a bare 500 page (I12).
		return fail(500, { error: released
			? 'The YouTube action failed — the comment is back in the queue. Try again.'
			: 'The YouTube action failed, but this comment changed while it was running. Refresh before retrying.' });
	}
	return { success: remoteMissing ? 'The comment no longer exists on YouTube — recorded as deleted.' : SUCCESS_TEXT[action] };
}

function commentIdFrom(formData: FormData): string | null {
	const raw = formData.get('commentId');
	if (typeof raw !== 'string') return null;
	return raw.trim();
}

export const actions = {
	approve: async ({ params, request, locals }) => {
		requireUser(locals);
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		return act(params.id, commentId, 'approve', locals);
	},
	reject: async ({ params, request, locals }) => {
		requireUser(locals);
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		return act(params.id, commentId, 'reject', locals);
	},
	del: async ({ params, request, locals }) => {
		requireUser(locals);
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		return act(params.id, commentId, 'delete', locals);
	},
	ban: async ({ params, request, locals }) => {
		requireUser(locals);
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		return act(params.id, commentId, 'ban', locals);
	}
};
