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

import { and, eq, inArray, sql } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { auditLog, comments } from '$lib/server/db/schema';

/**
 * Comment counts grouped by channel and status for the given channels.
 * Callers scope the id list to the signed-in user's org BEFORE calling —
 * this helper deliberately has no tenancy logic of its own.
 */
export async function commentCountsByChannel(channelIds: string[]) {
	if (channelIds.length === 0) return [];
	return db
		.select({ channelId: comments.channelId, status: comments.status, n: sql<number>`count(*)` })
		.from(comments)
		.where(inArray(comments.channelId, channelIds))
		.groupBy(comments.channelId, comments.status)
		.all();
}

/**
 * Ban counts grouped by channel for the given channels.
 * Counts ban EVENTS from the audit log, not moderation_actions: manual queue
 * bans never create moderation_actions rows, so counting that table hid
 * every user-taken ban. Both ban paths write exactly one audit row per ban
 * (pipeline: completeActions, same transaction as the completed update;
 * manual: the queue action itself). Bans are irreversible, so ban events
 * equal ban state; dry-run rows are excluded by the action filter.
 */
export async function banCountsByChannel(channelIds: string[]) {
	if (channelIds.length === 0) return [];
	return db
		.select({ channelId: auditLog.channelId, n: sql<number>`count(*)` })
		.from(auditLog)
		.where(and(eq(auditLog.action, 'ban'), inArray(auditLog.channelId, channelIds)))
		.groupBy(auditLog.channelId)
		.all();
}
