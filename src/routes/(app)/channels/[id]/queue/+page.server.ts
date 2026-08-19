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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { db } from '$lib/server/db';
import { comments, auditLog } from '$lib/server/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { refreshAccessToken, setModerationStatus, deleteComment } from '$lib/server/youtube';
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
	const pending = await db
		.select({
			id: comments.id,
			text: comments.text,
			publishedAt: comments.publishedAt
		})
		.from(comments)
		.where(and(eq(comments.channelId, params.id), eq(comments.status, 'pending')))
		.orderBy(desc(comments.publishedAt))
		.limit(100)
		.all();
	// Project only what the page renders — never serialize refreshTokenEnc (or
	// any future secret column) or legacy author columns to the browser.
	return { ch: { id: ch.id, title: ch.title }, pending };
}

/** DB status for a human review action (no nested ternary — sonarcloud S3358). */
function statusForAction(action: 'approve' | 'reject' | 'delete' | 'ban'): 'approved' | 'deleted' | 'rejected' {
	if (action === 'approve') return 'approved';
	if (action === 'delete') return 'deleted';
	return 'rejected';
}

async function act(paramsId: string, commentId: string, action: 'approve' | 'reject' | 'delete' | 'ban', locals: App.Locals) {
	const ch = await ownedChannel(paramsId, locals);
	const status = statusForAction(action);
	// Atomically claim the still-pending comment BEFORE any external call.
	// Concurrent submissions otherwise both pass the pending check and issue
	// duplicate YouTube actions and duplicate audit rows; with the conditional
	// update, the loser finds zero rows and 404s.
	const claimed = await db
		.update(comments)
		.set({ status, decidedBy: 'human' })
		.where(and(eq(comments.id, commentId), eq(comments.channelId, paramsId), eq(comments.status, 'pending')))
		.returning({ id: comments.id });
	if (claimed.length === 0) throw error(404, 'pending comment not found in this channel');
	const dryRun = env.DRY_RUN === 'true';
	try {
		if (!dryRun && action !== 'approve') {
			const token = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
			if (action === 'reject') await setModerationStatus([commentId], 'rejected', false, token);
			if (action === 'ban') await setModerationStatus([commentId], 'rejected', true, token);
			if (action === 'delete') await deleteComment(commentId, token);
		}
	} catch (e) {
		// Release the claim so a failed external action stays retryable.
		await db.update(comments).set({ status: 'pending', decidedBy: 'none' }).where(eq(comments.id, commentId));
		throw e;
	}
	await db.insert(auditLog).values({
		channelId: paramsId,
		commentId,
		action: dryRun ? 'dry-run' : action,
		reason: 'manual review',
		actor: 'user',
		// No handle source at manual-action time: comments.author_name is never persisted by design.
		authorHandle: null,
		createdAt: new Date().toISOString()
	});
}

function commentIdFrom(formData: FormData): string | null {
	const raw = formData.get('commentId');
	if (typeof raw !== 'string') return null;
	const id = raw.trim();
	return id ?? null;
}

export const actions = {
	approve: async ({ params, request, locals }) => {
		requireUser(locals);
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		await act(params.id, commentId, 'approve', locals);
		return { success: 'Approved — recorded in audit log.' };
	},
	reject: async ({ params, request, locals }) => {
		requireUser(locals);
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		await act(params.id, commentId, 'reject', locals);
		return { success: 'Rejected — recorded in audit log.' };
	},
	del: async ({ params, request, locals }) => {
		requireUser(locals);
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		await act(params.id, commentId, 'delete', locals);
		return { success: 'Deleted — recorded in audit log.' };
	},
	ban: async ({ params, request, locals }) => {
		requireUser(locals);
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		await act(params.id, commentId, 'ban', locals);
		return { success: 'Author banned — recorded in audit log.' };
	}
};
