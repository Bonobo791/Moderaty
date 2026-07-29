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

export async function load({ params }) {
	const ch = await db.select().from(channels).where(eq(channels.id, params.id)).get();
	const pending = await db
		.select()
		.from(comments)
		.where(and(eq(comments.channelId, params.id), eq(comments.status, 'pending')))
		.orderBy(desc(comments.publishedAt))
		.limit(100)
		.all();
	return { ch, pending };
}

async function act(paramsId: string, commentId: string, action: 'approve' | 'reject' | 'delete' | 'ban') {
	const ch = await db.select().from(channels).where(eq(channels.id, paramsId)).get();
	if (!ch) throw new Error('channel not found');
	if (process.env.DRY_RUN !== 'true' && action !== 'approve') {
		const token = await refreshAccessToken(decrypt(ch.refreshTokenEnc));
		if (action === 'reject') await setModerationStatus([commentId], 'rejected', false, token);
		if (action === 'ban') await setModerationStatus([commentId], 'rejected', true, token);
		if (action === 'delete') await deleteComment(commentId, token);
	}
	const status = action === 'approve' ? 'approved' : action === 'delete' ? 'deleted' : 'rejected';
	await db.update(comments).set({ status, decidedBy: 'human' }).where(eq(comments.id, commentId));
	await db.insert(auditLog).values({
		channelId: paramsId,
		commentId,
		action: process.env.DRY_RUN === 'true' ? 'dry-run' : action,
		reason: 'manual review',
		actor: 'user',
		createdAt: new Date().toISOString()
	});
}

export const actions = {
	approve: async ({ params, request }) => {
		await act(params.id, String((await request.formData()).get('commentId')), 'approve');
	},
	reject: async ({ params, request }) => {
		await act(params.id, String((await request.formData()).get('commentId')), 'reject');
	},
	del: async ({ params, request }) => {
		await act(params.id, String((await request.formData()).get('commentId')), 'delete');
	},
	ban: async ({ params, request }) => {
		await act(params.id, String((await request.formData()).get('commentId')), 'ban');
	}
};
