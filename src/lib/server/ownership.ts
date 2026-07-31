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

import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { requireUser, type SessionUser } from '$lib/server/session';

/**
 * Loads a channel only when the signed-in user owns it. The single ownership
 * gate for every channel-scoped route: 401 when signed out, 404 when the
 * channel is missing or owned by someone else (never leak existence).
 */
export async function ownedChannel(channelId: string, locals: { user: SessionUser | null }) {
	const user = requireUser(locals);
	const ch = await db
		.select()
		.from(channels)
		.where(and(eq(channels.id, channelId), eq(channels.userId, user.id)))
		.get();
	if (!ch) throw error(404, 'channel not found');
	return ch;
}
