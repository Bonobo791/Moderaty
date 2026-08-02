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

/**
 * Calculates the cutoff timestamp for the account-deletion retention window.
 *
 * @param now - The reference time in milliseconds since the Unix epoch
 * @returns The ISO timestamp 180 days before `now`
 */
export function retentionCutoffIso(now = Date.now()): string {
	return new Date(now - RETENTION_MS).toISOString();
}

/**
 * Determines whether a soft-deleted account has exceeded the retention period.
 *
 * @param deletedAt - The account's soft-deletion timestamp in ISO format
 * @param now - The current time as a Unix timestamp in milliseconds
 * @returns `true` if the deletion timestamp precedes the retention cutoff, `false` otherwise
 */
export function isRetentionExpired(deletedAt: string, now = Date.now()): boolean {
	return deletedAt < retentionCutoffIso(now);
}

/**
 * Permanently removes a user's owned records while preserving an anonymized user tombstone for retained consent records.
 *
 * The caller selects the user OUTSIDE this transaction, so the account may
 * have been restored (deleted_at cleared) or re-deleted (new deleted_at) by a
 * concurrent sign-in before the purge starts. The deletion marker is therefore
 * re-verified atomically inside the transaction; a mismatch skips the purge.
 *
 * @param userId - The ID of the user to purge
 * @param expectedDeletedAt - The soft-deletion timestamp the caller selected on; a changed marker aborts the purge
 * @returns `true` when the purge ran, `false` when the deletion marker no longer matches
 */
export async function purgeUserById(userId: string, expectedDeletedAt?: string): Promise<boolean> {
	return await db.transaction(async (tx) => {
		const user = await tx.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, userId)).get();
		if (!user?.deletedAt) return false;
		if (expectedDeletedAt !== undefined && user.deletedAt !== expectedDeletedAt) return false;
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
		return true;
	});
}

/**
 * Purges the oldest user whose soft-deletion retention period has expired.
 *
 * @returns The purged user ID, or `null` when no expired user exists (or the
 * selected account was restored before its purge transaction ran).
 */
export async function purgeExpiredUser(): Promise<string | null> {
	const expired = await db
		.select({ id: users.id, deletedAt: users.deletedAt })
		.from(users)
		.where(and(isNotNull(users.deletedAt), lt(users.deletedAt, retentionCutoffIso())))
		.orderBy(asc(users.deletedAt))
		.limit(1)
		.get();
	if (!expired?.deletedAt) return null;
	const purged = await purgeUserById(expired.id, expired.deletedAt);
	return purged ? expired.id : null;
}
