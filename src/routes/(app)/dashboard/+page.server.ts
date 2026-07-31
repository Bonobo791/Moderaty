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
import { channels, comments, moderationActions } from '$lib/server/db/schema';
import { requireUser } from '$lib/server/session';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';

export async function load({ locals }) {
	const user = requireUser(locals);
	// Project only the fields the page renders; never serialize refreshTokenEnc
	// (or any future secret column) to the browser. Everything below is scoped
	// to channels the signed-in user owns.
	const chs = await db
		.select({ id: channels.id, title: channels.title, cursor: channels.cursor, toneLevel: channels.toneLevel })
		.from(channels)
		.where(eq(channels.userId, user.id))
		.all();
	const channelIds = chs.map((ch) => ch.id);
	const stats = channelIds.length
		? await db
				.select({ channelId: comments.channelId, status: comments.status, n: sql<number>`count(*)` })
				.from(comments)
				.where(inArray(comments.channelId, channelIds))
				.groupBy(comments.channelId, comments.status)
				.all()
		: [];
	const bans = channelIds.length
		? await db
				.select({ channelId: moderationActions.channelId, n: sql<number>`count(*)` })
				.from(moderationActions)
				.where(
					and(
						eq(moderationActions.action, 'ban'),
						eq(moderationActions.state, 'completed'),
						inArray(moderationActions.channelId, channelIds)
					)
				)
				.groupBy(moderationActions.channelId)
				.all()
		: [];
	return { chs, stats, bans };
}

export const actions = {
	setToneLevel: async ({ request, locals }) => {
		const user = requireUser(locals);
		const f = await request.formData();
		const channelId = String(f.get('channelId') ?? '');
		const toneLevel = Number(f.get('toneLevel'));
		if (toneLevel !== 1 && toneLevel !== 2) {
			return fail(400, { error: 'tone level must be 1 (Edge Lord) or 2 (Edge lord + Ackchyually…)' });
		}
		// Ownership-scoped: another user's channel reads as "not found".
		const updated = await db
			.update(channels)
			.set({ toneLevel })
			.where(and(eq(channels.id, channelId), eq(channels.userId, user.id)))
			.returning({ id: channels.id });
		if (updated.length === 0) return fail(404, { error: 'channel not found' });
		return { ok: true };
	}
};
