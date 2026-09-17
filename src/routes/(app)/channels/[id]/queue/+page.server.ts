// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { db, withBusyRetry } from '$lib/server/db';
import { comments, auditLog, moderationActions } from '$lib/server/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { refreshAccessToken, getCommentModerationStatus } from '$lib/server/youtube';
import { applyHumanIntent, finalizeHumanIntent } from '$lib/server/pipeline/enforcement';
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
			holdState: moderationActions.state
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
				.where(and(eq(comments.id, commentId), eq(comments.channelId, paramsId), eq(comments.status, 'pending')))
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
			.where(and(eq(comments.id, commentId), eq(comments.channelId, paramsId), eq(comments.status, 'pending')))
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
		return { intentId: intent[0].id };
	}));
	if (!claim) throw error(404, 'pending comment not found in this channel');
	try {
		const token = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
		// Preflight the real remote state: approve publishes ANY non-public
		// state, a landed hold is audited at finalize, and the post-write
		// verify converges an in-flight hold landing after the decision.
		const remote = await getCommentModerationStatus(commentId, token);
		const { holdLanded } = await applyHumanIntent(commentId, action, remote, token);
		await finalizeHumanIntent(paramsId, commentId, action, holdLanded);
	} catch (e) {
		// Release the claim: the comment returns to 'pending', the staged
		// intent row is dropped (nothing committed), and any hold a concurrent
		// enforcement superseded on the strength of the claim is re-armed —
		// one transaction, or the comment can sit 'pending' with a terminally-
		// superseded hold: public on YouTube while the queue calls it held.
		// A 'dispatched' hold stays dispatched — the reconcile loop re-verifies
		// it against the restored 'pending'.
		await db.transaction(async (transaction) => {
			await transaction
				.update(comments)
				.set({ status: 'pending', decidedBy: 'none' })
				.where(eq(comments.id, commentId));
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
		});
		// Full error detail stays server-side; the client gets a generic
		// message in the error-box instead of a bare 500 page (I12).
		console.error(`[queue] ${action} failed for comment ${commentId}`, e);
		return fail(500, { error: 'The YouTube action failed — the comment is back in the queue. Try again.' });
	}
	return { success: SUCCESS_TEXT[action] };
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
