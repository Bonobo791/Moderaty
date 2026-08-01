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

// Account-deletion retention, shared by the cron purge sweep and the login
// callback so both enforce the exact same cutoff.

import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { auditLog, channels, comments, moderationActions, rules, sessions, users } from '$lib/server/db/schema';

export const RETENTION_MS = 180 * 24 * 60 * 60 * 1000; // 180 days ≈ 6 months

/** ISO cutoff: soft-deleted before this moment = past the retention window. */
export function retentionCutoffIso(now = Date.now()): string {
	return new Date(now - RETENTION_MS).toISOString();
}

/** True when a soft-delete marker is past the retention window. */
export function isRetentionExpired(deletedAt: string, now = Date.now()): boolean {
	return deletedAt < retentionCutoffIso(now);
}

/**
 * Permanently removes everything ONE user owned — sessions, channels and
 * their rules/comments/moderation actions/audit rows — EXCEPT the evidentiary
 * consent log (LGPD Art. 16 legal-defense retention): the users row is
 * anonymized to a tombstone so consents.userId stays valid and the real
 * Google sub is freed for a future fresh signup. deletedAt is cleared so the
 * tombstone never re-enters the purge queue and starves other expired users.
 */
export async function purgeUserById(userId: string): Promise<void> {
	await db.transaction(async (tx) => {
		const chs = await tx.select({ id: channels.id }).from(channels).where(eq(channels.userId, userId)).all();
		const channelIds = chs.map((ch) => ch.id);
		if (channelIds.length) {
			await tx.delete(moderationActions).where(inArray(moderationActions.channelId, channelIds));
			await tx.delete(comments).where(inArray(comments.channelId, channelIds));
			await tx.delete(auditLog).where(inArray(auditLog.channelId, channelIds));
			await tx.delete(rules).where(inArray(rules.channelId, channelIds));
		}
		await tx.delete(channels).where(eq(channels.userId, userId));
		await tx.delete(sessions).where(eq(sessions.userId, userId));
		await tx
			.update(users)
			.set({ googleSub: `deleted:${userId}`, email: '[deleted]', displayName: '[deleted]', deletedAt: null })
			.where(eq(users.id, userId));
	});
}

/**
 * Purges ONE user past the retention window (I10: the rest drain across
 * invocations, oldest first). Returns the purged user id, or null.
 */
export async function purgeExpiredUser(): Promise<string | null> {
	const expired = await db
		.select({ id: users.id })
		.from(users)
		.where(and(isNotNull(users.deletedAt), lt(users.deletedAt, retentionCutoffIso())))
		.orderBy(asc(users.deletedAt))
		.limit(1)
		.get();
	if (!expired) return null;
	await purgeUserById(expired.id);
	return expired.id;
}
