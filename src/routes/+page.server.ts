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
import { channels, comments } from '$lib/server/db/schema';
import { sql } from 'drizzle-orm';

export async function load() {
	// Project only the fields the page renders; never serialize refreshTokenEnc
	// (or any future secret column) to the browser.
	const chs = await db
		.select({ id: channels.id, title: channels.title, cursor: channels.cursor })
		.from(channels)
		.all();
	const stats = await db
		.select({ channelId: comments.channelId, status: comments.status, n: sql<number>`count(*)` })
		.from(comments)
		.groupBy(comments.channelId, comments.status)
		.all();
	return { chs, stats };
}
