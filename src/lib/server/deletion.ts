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

import { and, eq, inArray, isNotNull, lt, ne } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { auditLog, channels, comments, consents, invites, memberships, moderationActions, organizations, rules, sessions, users } from '$lib/server/db/schema';

export const CONSENT_EMAIL_RETENTION_MS = 10 * 365.25 * 24 * 60 * 60 * 1000; // 10 years

const CONSENT_SWEEP_BATCH = 50; // bounded per cron invocation (I10)

/** Placeholder for an erased refresh token — never valid ciphertext, so decrypt fails loudly in cron (AGENTS.md). */
export const WIPED_REFRESH_TOKEN = 'erased:account-deletion';

/**
 * Deletes a set of channels and every row they own, child-to-parent:
 * moderation actions, comments, audit rows, rules, then the channel rows
 * themselves. Shared by account deletion (every channel in dissolved orgs)
 * and the dashboard's per-channel disconnect. Call inside a transaction.
 *
 * With `expectedOrgId` (the disconnect path, which authorized via a SELECT
 * BEFORE this transaction), the channel rows are deleted FIRST with the org
 * as a delete predicate: if a channel was reconnected under a different org
 * in between, the predicate matches nothing and the whole transaction aborts
 * loudly instead of erasing another tenant's channel (TOCTOU). The first
 * DELETE also takes the write lock, so no reconnect can interleave before
 * the child rows go.
 */
export async function deleteChannelRecords(
	tx: Pick<typeof db, 'delete'>,
	channelIds: string[],
	options?: { expectedOrgId?: string }
): Promise<void> {
	if (!channelIds.length) return;
	// Child rows of the channels, child-to-parent, identical in both branches.
	// (Codacy duplication: the four-delete sequence was copy-pasted in each
	// branch — extracted so the child-delete list lives once.)
	const deleteChildren = async () => {
		await tx.delete(moderationActions).where(inArray(moderationActions.channelId, channelIds));
		await tx.delete(comments).where(inArray(comments.channelId, channelIds));
		await tx.delete(auditLog).where(inArray(auditLog.channelId, channelIds));
		await tx.delete(rules).where(inArray(rules.channelId, channelIds));
	};
	if (options?.expectedOrgId) {
		const removed = await tx
			.delete(channels)
			.where(and(inArray(channels.id, channelIds), eq(channels.orgId, options.expectedOrgId)))
			.returning({ id: channels.id });
		if (removed.length !== channelIds.length) {
			throw new Error('deleteChannelRecords: channel tenancy changed mid-request — aborting');
		}
		await deleteChildren();
		return;
	}
	await deleteChildren();
	await tx.delete(channels).where(inArray(channels.id, channelIds));
}

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
 * One transaction: for every org the user belongs to, either dissolve it
 * (sole-member orgs — always true of the personal org — go with their
 * channels, moderation actions, comments, audit rows, rules, and invites)
 * or leave it to its surviving members (shared orgs), promoting the oldest
 * admin — else the oldest member — to owner when the deleting user was the
 * last owner, so a surviving org is never left ownerless. Every session;
 * and the rest of the user's tenancy — every remaining membership and every
 * invite they created — goes too. Explicit
 * deletes in child-to-parent order rather than FK reliance: the users row is
 * only tombstoned, so ON DELETE CASCADE never fires. A channel the user
 * merely CONNECTED (channels.userId) in a surviving team org is NOT deleted —
 * it and its moderation history belong to the team; it is detached instead
 * (userId NULL, token wiped) so cron fails loudly until a teammate
 * reconnects. The users row is
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
	// Promotions are logged only AFTER the transaction commits — a pre-commit
	// log would claim a succession that a rollback erased.
	const promotions: { orgId: string; successorId: string }[] = [];
	await db.transaction(async (tx) => {
		const user = await tx
			.select({ googleSub: users.googleSub })
			.from(users)
			.where(eq(users.id, userId))
			.get();
		if (!user || user.googleSub.startsWith('deleted:')) {
			throw new Error(`deleteUserRecords: user ${userId} not found or already deleted`);
		}
		// Tenancy first: per-org fates (dissolve versus survive) decide which
		// channels die with the account versus detach (team ones the user only
		// connected). The personal org is single-member by definition; a shared
		// org the user merely belongs to survives (its other members own it) —
		// only the user's membership row leaves.
		const personalOrgs = await tx
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.personalFor, userId))
			.all();
		const personalOrgIds = personalOrgs.map((o) => o.id);
		// Stryker disable next-line ConditionalExpression: true equivalent — with zero personal orgs the guard queries inArray([]), which drizzle compiles to `false`; 0 !== 0 and [].some() are both false, so the guard body can never fire either way.
		if (personalOrgIds.length) {
			// Data-bug guard: a personal org is single-member by definition, but
			// the schema cannot enforce that. Require exactly one membership per
			// personal org, owned by the deleting user — anything else (a second
			// member, or a sole member who ISN'T this user) means deleting the
			// org would destroy someone else's tenancy and channels. Fail loudly
			// and abort the whole deletion.
			const orgMembers = await tx
				.select({ userId: memberships.userId })
				.from(memberships)
				.where(inArray(memberships.orgId, personalOrgIds))
				.all();
			// Stryker disable next-line MethodExpression: every equivalent — organizations.personalFor is UNIQUE (at most one personal org per user), so a mixed-owner member list with a matching count is schema-impossible; with zero or one rows some ≡ every here.
			if (orgMembers.length !== personalOrgIds.length || orgMembers.some((m) => m.userId !== userId)) {
				console.error(`user ${userId}'s personal org membership is inconsistent (${orgMembers.length} rows) — refusing account deletion`);
				throw new Error('personal organization has other members — contact support');
			}
		}
		// Every org the user belongs to decides its own fate. A sole-member org
		// (personal or shared — the guard above already proved personal orgs are
		// sole-member) has no one to survive to, so it dissolves with its
		// channels and data. A shared org with other members survives; when the
		// deleting user was its LAST owner, ownership passes to the oldest admin,
		// else the oldest member (seniority = join order, userId breaking ties),
		// so a shared org is never left ownerless.
		const userMemberships = await tx
			.select({ orgId: memberships.orgId, role: memberships.role })
			.from(memberships)
			.where(eq(memberships.userId, userId))
			.all();
		// One batched query for every co-member across all the user's orgs —
		// no per-org roundtrips (N+1) inside the transaction.
		const memberOrgIds = userMemberships.map((m) => m.orgId);
		const coMembers = memberOrgIds.length
			? await tx
					.select({
						orgId: memberships.orgId,
						userId: memberships.userId,
						role: memberships.role,
						createdAt: memberships.createdAt
					})
					.from(memberships)
					.where(and(inArray(memberships.orgId, memberOrgIds), ne(memberships.userId, userId)))
					.all()
			: // Stryker disable next-line ArrayDeclaration: sentinel equivalent — this branch means userMemberships is empty, and the only reader of coMembersByOrg loops over userMemberships, so the injected row is never read.
				[];
		const coMembersByOrg = new Map<string, typeof coMembers>();
		for (const row of coMembers) {
			// Stryker disable next-line ArrayDeclaration: sentinel equivalent — the injected string's .createdAt is undefined, which localeCompare coerces to "undefined"; ISO dates start with digits ('2' < 'u'), so it always sorts last, find(role==='admin') skips it (role undefined), and ranked[0] is always a real row.
			const list = coMembersByOrg.get(row.orgId) ?? [];
			list.push(row);
			coMembersByOrg.set(row.orgId, list);
		}
		// Stryker disable next-line ArrayDeclaration: sentinel equivalent — org ids are randomBytes(16) hex (ensurePersonalOrg in org.ts), never "Stryker was here", so the extra inArray element matches no row and deletes nothing.
		const dissolveOrgIds: string[] = [];
		for (const membership of userMemberships) {
			const others = coMembersByOrg.get(membership.orgId) ?? [];
			if (!others.length) {
				dissolveOrgIds.push(membership.orgId);
				continue;
			}
			if (membership.role === 'owner' && !others.some((m) => m.role === 'owner')) {
				const ranked = [...others].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.userId.localeCompare(b.userId));
				const successor = ranked.find((m) => m.role === 'admin') ?? ranked[0];
				const promoted = await tx
					.update(memberships)
					.set({ role: 'owner' })
					.where(and(eq(memberships.orgId, membership.orgId), eq(memberships.userId, successor.userId)))
					.returning({ userId: memberships.userId });
				// The row was selected in this same transaction; an empty RETURNING
				// means the data changed underneath us — fail loudly, never log a
				// promotion that did not persist.
				if (!promoted.length) {
					console.error(`account deletion: successor ${successor.userId} vanished from org ${membership.orgId} mid-transaction`);
					throw new Error('ownership succession failed — contact support');
				}
				promotions.push({ orgId: membership.orgId, successorId: successor.userId });
			}
		}
		const chs = dissolveOrgIds.length
			? await tx.select({ id: channels.id }).from(channels).where(inArray(channels.orgId, dissolveOrgIds)).all()
			: [];
		const channelIds = chs.map((ch) => ch.id);
		// Every channel in a dissolved org dies with it, history included.
		await deleteChannelRecords(tx, channelIds);
		// Detach team channels this account connected: the row and history stay
		// with the team; the dead grant is wiped so nothing silently moderates.
		await tx
			.update(channels)
			.set({ userId: null, refreshTokenEnc: WIPED_REFRESH_TOKEN })
			.where(eq(channels.userId, userId));
		await tx.delete(sessions).where(eq(sessions.userId, userId));
		// Stryker disable next-line ConditionalExpression: true equivalent — with zero dissolved orgs the deletes run inArray([]), which drizzle compiles to `false`: no rows match, nothing is deleted.
		if (dissolveOrgIds.length) {
			await tx.delete(invites).where(inArray(invites.orgId, dissolveOrgIds));
			await tx.delete(memberships).where(inArray(memberships.orgId, dissolveOrgIds));
			await tx.delete(organizations).where(inArray(organizations.id, dissolveOrgIds));
		}
		await tx.delete(invites).where(eq(invites.createdBy, userId));
		await tx.delete(memberships).where(eq(memberships.userId, userId));
		await tx
			.update(users)
			.set({ googleSub: `deleted:${userId}`, email: '[deleted]', displayName: '[deleted]' })
			.where(eq(users.id, userId));
	});
	for (const promotion of promotions) {
		console.info(
			`account deletion: promoted user ${promotion.successorId} to owner of org ${promotion.orgId} (last owner ${userId} was deleted)`
		);
	}
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
	// Stryker disable next-line ConditionalExpression: false equivalent — with zero expired rows the update runs inArray([]) (drizzle compiles to `false`, no rows updated) and expired.length is 0, so the skipped early return returns the same 0.
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
