// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { db } from '$lib/server/db';
import { channels, comments, auditLog } from '$lib/server/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { refreshAccessToken, setModerationStatus, deleteComment } from '$lib/server/youtube';
import { decrypt } from '$lib/server/crypto';
import { ownedChannel } from '$lib/server/ownership';
import { env } from '$env/dynamic/private';
import { error, fail } from '@sveltejs/kit';

export async function load({ params, locals }) {
	const ch = await ownedChannel(params.id, locals);
	const pending = await db
		.select()
		.from(comments)
		.where(and(eq(comments.channelId, params.id), eq(comments.status, 'pending')))
		.orderBy(desc(comments.publishedAt))
		.limit(100)
		.all();
	return { ch, pending };
}

async function act(paramsId: string, commentId: string, action: 'approve' | 'reject' | 'delete' | 'ban', locals: App.Locals) {
	const ch = await ownedChannel(paramsId, locals);
	// Scope to this route's channel and to still-pending comments so a forged
	// POST cannot moderate another channel's comment or re-decide a settled one.
	const comment = await db
		.select({ id: comments.id })
		.from(comments)
		.where(
			and(
				eq(comments.id, commentId),
				eq(comments.channelId, paramsId),
				eq(comments.status, 'pending')
			)
		)
		.get();
	if (!comment) throw error(404, 'pending comment not found in this channel');
	const dryRun = env.DRY_RUN === 'true';
	if (!dryRun && action !== 'approve') {
		const token = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
		if (action === 'reject') await setModerationStatus([commentId], 'rejected', false, token);
		if (action === 'ban') await setModerationStatus([commentId], 'rejected', true, token);
		if (action === 'delete') await deleteComment(commentId, token);
	}
	const status = action === 'approve' ? 'approved' : action === 'delete' ? 'deleted' : 'rejected';
	await db
		.update(comments)
		.set({ status, decidedBy: 'human' })
		.where(and(eq(comments.id, commentId), eq(comments.channelId, paramsId)));
	await db.insert(auditLog).values({
		channelId: paramsId,
		commentId,
		action: dryRun ? 'dry-run' : action,
		reason: 'manual review',
		actor: 'user',
		createdAt: new Date().toISOString()
	});
}

function commentIdFrom(formData: FormData): string | null {
	const raw = formData.get('commentId');
	if (typeof raw !== 'string') return null;
	const id = raw.trim();
	return id ? id : null;
}

export const actions = {
	approve: async ({ params, request, locals }) => {
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		await act(params.id, commentId, 'approve', locals);
		return { success: 'Approved — recorded in audit log.' };
	},
	reject: async ({ params, request, locals }) => {
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		await act(params.id, commentId, 'reject', locals);
		return { success: 'Rejected — recorded in audit log.' };
	},
	del: async ({ params, request, locals }) => {
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		await act(params.id, commentId, 'delete', locals);
		return { success: 'Deleted — recorded in audit log.' };
	},
	ban: async ({ params, request, locals }) => {
		const commentId = commentIdFrom(await request.formData());
		if (!commentId) return fail(400, { error: 'Invalid comment ID' });
		await act(params.id, commentId, 'ban', locals);
		return { success: 'Author banned — recorded in audit log.' };
	}
};
