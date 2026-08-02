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
import { auditLog } from '$lib/server/db/schema';
import { ownedChannel } from '$lib/server/ownership';
import { eq, desc } from 'drizzle-orm';

export async function load({ params, locals }) {
	// Ownership-scoped: another user's channel (and its audit log) reads as "not found".
	const ch = await ownedChannel(params.id, locals);
	const rows = await db
		.select()
		.from(auditLog)
		.where(eq(auditLog.channelId, params.id))
		.orderBy(desc(auditLog.createdAt))
		.limit(200)
		.all();
	// Newest first: the first entry seen per comment is its latest action, and
	// only that one can be undone. 'hold'/'reject' reverse fully via YouTube;
	// 'ban' restores the comment but the author ban is permanent (no API);
	// everything else ('delete', 'approve', 'queue', 'dry-run', 'restore') is
	// not reversible.
	const seen = new Set<string>();
	const entries = rows.map((entry) => {
		const latest = !seen.has(entry.commentId);
		seen.add(entry.commentId);
		const undoable =
			latest && (entry.action === 'hold' || entry.action === 'reject')
				? 'full'
				: latest && entry.action === 'ban'
					? 'comment-only'
					: null;
		return { ...entry, undoable: undoable as 'full' | 'comment-only' | null };
	});
	// Project only what the page renders — never serialize refreshTokenEnc (or
	// any future secret column) to the browser.
	return { ch: { id: ch.id, title: ch.title }, entries };
}
