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
