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

// Account deletion (immediate) and the consent-evidence retention sweep.
//
// Policy: account deletion erases everything immediately EXCEPT the
// statutory-retention items — the `consents` evidentiary log, which keeps
// the e-mail, document versions, timestamps, IP, and user agent under LGPD
// Art. 16, III (regular exercise of rights in proceedings). That e-mail is
// blocked from any other use by architecture: it exists ONLY in the
// write-once consent log, and a cron sweep erases it 10 years after
// acceptance (CC Art. 205, conservative over CDC's 5-year prescription).
// The consent row itself is kept, anonymized.

import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { auditLog, channels, comments, consents, invites, memberships, moderationActions, organizations, rules, sessions, users } from '$lib/server/db/schema';

export const CONSENT_EMAIL_RETENTION_MS = 10 * 365.25 * 24 * 60 * 60 * 1000; // 10 years

const CONSENT_SWEEP_BATCH = 50; // bounded per cron invocation (I10)

/**
 * Calculates the cutoff timestamp for consent e-mail retention.
 *
 * @param now - The reference time in milliseconds since the Unix epoch
 * @returns The ISO timestamp 10 years before `now`
 */
export function consentEmailCutoffIso(now = Date.now()): string {
	return new Date(now - CONSENT_EMAIL_RETENTION_MS).toISOString();
}

/**
 * Immediately and permanently erases a user's account data, preserving only the anonymized tombstone and the consent log.
 *
 * One transaction: moderation actions, comments, audit rows, and rules for
 * the user's channels; the channels themselves; every session; and the
 * user's tenancy — the personal org (whose name is the user's display name,
 * i.e. PII), every membership, and every invite they created. Explicit
 * deletes in child-to-parent order rather than FK reliance: the users row is
 * only tombstoned, so ON DELETE CASCADE never fires. The users row is
 * anonymized to a tombstone (`googleSub: 'deleted:<id>'`, e-mail and
 * display name wiped) so the same Google identity can sign up again and the
 * `consents` evidentiary log survives with its foreign key intact. The
 * e-mail survives ONLY in `consents` (statutory retention, Art. 16, III) —
 * never in the live users table. OAuth token revocation happens at the
 * caller, BEFORE this erase (the encrypted tokens die here either way).
 *
 * @param userId - The ID of the user to erase
 * @throws If the user does not exist or is already tombstoned
 */
export async function deleteUserRecords(userId: string): Promise<void> {
	await db.transaction(async (tx) => {
		const user = await tx
			.select({ googleSub: users.googleSub })
			.from(users)
			.where(eq(users.id, userId))
			.get();
		if (!user || user.googleSub.startsWith('deleted:')) {
			throw new Error(`deleteUserRecords: user ${userId} not found or already deleted`);
		}
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
		// Tenancy erasure. The personal org is single-member by definition; a
		// shared org the user merely belongs to survives (its other members own
		// it) — only the user's membership row leaves.
		const personalOrgs = await tx
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.personalFor, userId))
			.all();
		const orgIds = personalOrgs.map((o) => o.id);
		if (orgIds.length) {
			await tx.delete(invites).where(inArray(invites.orgId, orgIds));
			await tx.delete(memberships).where(inArray(memberships.orgId, orgIds));
			await tx.delete(organizations).where(inArray(organizations.id, orgIds));
		}
		await tx.delete(invites).where(eq(invites.createdBy, userId));
		await tx.delete(memberships).where(eq(memberships.userId, userId));
		await tx
			.update(users)
			.set({ googleSub: `deleted:${userId}`, email: '[deleted]', displayName: '[deleted]' })
			.where(eq(users.id, userId));
	});
}

/**
 * Erases the e-mail from consent records older than the 10-year retention period.
 *
 * The consent ROW is kept (document version, checkbox text, timestamps stay
 * as anonymized evidence); only the personal identifier is erased. Bounded
 * to one small batch per call (I10) — repeated cron invocations drain the
 * backlog.
 *
 * @returns The number of consent rows whose e-mail was erased
 */
export async function nullExpiredConsentEmails(): Promise<number> {
	const expired = await db
		.select({ id: consents.id })
		.from(consents)
		.where(and(isNotNull(consents.email), lt(consents.createdAt, consentEmailCutoffIso())))
		.limit(CONSENT_SWEEP_BATCH)
		.all();
	if (!expired.length) return 0;
	await db
		.update(consents)
		.set({ email: null })
		.where(
			inArray(
				consents.id,
				expired.map((row) => row.id)
			)
		);
	return expired.length;
}
