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
	const entries = await db
		.select()
		.from(auditLog)
		.where(eq(auditLog.channelId, params.id))
		.orderBy(desc(auditLog.createdAt))
		.limit(200)
		.all();
	return { ch, entries };
}
