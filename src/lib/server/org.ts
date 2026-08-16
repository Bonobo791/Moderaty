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

// DIY organization tenancy — no auth library, per the project's dependency policy.

import { randomBytes } from 'node:crypto';

import { error } from '@sveltejs/kit';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { invites, memberships, organizations, sessions, users } from '$lib/server/db/schema';
import { rotateSession } from '$lib/server/session';

export type OrgRole = 'owner' | 'admin' | 'member';

export interface OrgContext {
	orgId: string;
	orgName: string;
	orgRole: OrgRole;
	plan: string;
}

/** Narrows a raw memberships.role string to OrgRole, failing loudly on data bugs. */
export function asOrgRole(role: string): OrgRole {
	if (role === 'owner' || role === 'admin' || role === 'member') return role;
	throw new Error(`unknown membership role: ${role}`);
}

/** All of a user's memberships joined to their orgs, oldest membership first (ties by org id), in SQL. */
async function fetchMembershipRows(userId: string) {
	return db
		.select({
			orgId: organizations.id,
			orgName: organizations.name,
			plan: organizations.plan,
			role: memberships.role,
			membershipCreatedAt: memberships.createdAt
		})
		.from(memberships)
		.innerJoin(organizations, eq(memberships.orgId, organizations.id))
		.where(eq(memberships.userId, userId))
		.orderBy(memberships.createdAt, memberships.orgId)
		.all();
}

/**
 * Resolves a user's active organization: the session's active_org_id when a
 * membership for it still exists, otherwise the user's OLDEST membership
 * (deterministic fallback — timestamp ties break by org id, in SQL). Returns
 * null only when the user has zero memberships — a data bug the caller must
 * treat as fatal, never as signed-out. `fellBack` is true only when an
 * explicit activeOrgId was supplied and no longer has a membership.
 */
export async function resolveActiveOrg(
	userId: string,
	activeOrgId: string | null
): Promise<{ org: OrgContext; fellBack: boolean } | null> {
	const rows = await fetchMembershipRows(userId);
	if (rows.length === 0) return null;
	const chosen = rows.find((r) => r.orgId === activeOrgId) ?? rows[0];
	return {
		org: { orgId: chosen.orgId, orgName: chosen.orgName, orgRole: asOrgRole(chosen.role), plan: chosen.plan },
		fellBack: activeOrgId !== null && chosen.orgId !== activeOrgId
	};
}

/** Every org the user belongs to, oldest membership first (ties by org id) — feeds the nav team switcher. */
export async function listOrgMemberships(userId: string) {
	const rows = await fetchMembershipRows(userId);
	return rows.map(({ orgId, orgName, role }) => ({ orgId, name: orgName, role: asOrgRole(role) }));
}

/**
 * Returns the id of the user's personal org, creating it (plus the owner
 * membership) when missing. Naming matches the 0012 backfill (the user's
 * display name). Idempotent per I4: a concurrent same-sub signup that lost
 * the user-insert race finds the org the winner already made. Callers that
 * must commit atomically with other writes (account creation) pass their
 * transaction as `handle`.
 */
export async function ensurePersonalOrg(
	handle: Pick<typeof db, 'insert' | 'select'>,
	user: { id: string; displayName: string }
): Promise<string> {
	const existing = await handle
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.personalFor, user.id))
		.get();
	if (existing) return existing.id;
	const orgId = randomBytes(16).toString('hex');
	await handle.insert(organizations).values({ id: orgId, name: user.displayName, personalFor: user.id });
	await handle.insert(memberships).values({ userId: user.id, orgId, role: 'owner' });
	return orgId;
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const ROLE_RANK = { member: 0, admin: 1, owner: 2 } as const;

/**
 * Throws 403 unless `role` meets the minimum. Single source of the role
 * ranking — ownership.ts's requireOrgRole delegates here. `?? -1`: an
 * unknown role ranks below every minimum — fail closed, never open
 * (`undefined < N` is false, which would silently allow).
 */
export function requireRole(role: OrgRole, minimum: 'admin' | 'owner'): void {
	if ((ROLE_RANK[role] ?? -1) < ROLE_RANK[minimum]) throw error(403, 'your team role does not allow this');
}

async function membershipOf(userId: string, orgId: string) {
	return db
		.select({ role: memberships.role })
		.from(memberships)
		.where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
		.get();
}

/** Throws 400 when the org is a personal team — personal teams can never have members or invites. */
async function requireSharedOrg(orgId: string): Promise<void> {
	const org = await db.select({ personalFor: organizations.personalFor }).from(organizations).where(eq(organizations.id, orgId)).get();
	if (org && org.personalFor !== null) {
		throw error(400, "personal teams can't have members — create a shared team to collaborate");
	}
}

/** Creates a shared org (personal_for NULL) and makes the creator its owner. */
export async function createOrg(userId: string, name: string): Promise<string> {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > 80) throw error(400, 'team name must be 1–80 characters');
	const orgId = randomBytes(16).toString('hex');
	await db.transaction(async (tx) => {
		await tx.insert(organizations).values({ id: orgId, name: trimmed });
		await tx.insert(memberships).values({ userId, orgId, role: 'owner' });
	});
	return orgId;
}

/** Renames an org. Caller must be admin+ in it (checked here, not by the route). */
export async function renameOrg(userId: string, orgId: string, name: string): Promise<void> {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > 80) throw error(400, 'team name must be 1–80 characters');
	const m = await membershipOf(userId, orgId);
	if (!m) throw error(404, 'team not found');
	requireRole(asOrgRole(m.role), 'admin');
	const updated = await db
		.update(organizations)
		.set({ name: trimmed })
		.where(eq(organizations.id, orgId))
		.returning({ id: organizations.id });
	// Stryker disable next-line ConditionalExpression, StringLiteral: unreachable guard — memberships.org_id REFERENCES organizations(id) ON DELETE CASCADE, so an existing membership implies the org row exists and the update always matches; empty result needs a cross-statement delete race.
	if (updated.length === 0) throw error(404, 'team not found');
}

/** Creates a single-use invite link token. Caller must be admin+; role is admin|member, never owner. */
export async function createInvite(userId: string, orgId: string, role: 'admin' | 'member'): Promise<string> {
	const m = await membershipOf(userId, orgId);
	if (!m) throw error(404, 'team not found');
	requireRole(asOrgRole(m.role), 'admin');
	if (role !== 'admin' && role !== 'member') throw error(400, 'invite role must be admin or member');
	await requireSharedOrg(orgId);
	const token = randomBytes(32).toString('hex');
	await db.insert(invites).values({
		token,
		orgId,
		role,
		createdBy: userId,
		expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString()
	});
	return token;
}

/** Revokes (deletes) an open invite. Caller must be admin+ in the invite's org. */
export async function revokeInvite(userId: string, token: string): Promise<void> {
	const inv = await db.select().from(invites).where(eq(invites.token, token)).get();
	if (!inv) throw error(404, 'invite not found');
	const m = await membershipOf(userId, inv.orgId);
	if (!m) throw error(404, 'invite not found'); // never leak which org an invite serves
	requireRole(asOrgRole(m.role), 'admin');
	await db.delete(invites).where(eq(invites.token, token));
}

export interface InvitePreview {
	orgName: string;
	role: 'admin' | 'member';
	expired: boolean;
	accepted: boolean;
}

/** Invite row joined to its org. Shared by previewInvite and acceptInvite; pass a transaction as `handle` for atomic check-and-burn. */
async function inviteWithOrg(handle: Pick<typeof db, 'select'>, token: string) {
	return handle
		.select({
			orgId: invites.orgId,
			role: invites.role,
			expiresAt: invites.expiresAt,
			acceptedBy: invites.acceptedBy,
			orgName: organizations.name,
			personalFor: organizations.personalFor
		})
		.from(invites)
		.innerJoin(organizations, eq(invites.orgId, organizations.id))
		.where(eq(invites.token, token))
		.get();
}

/** Public preview for /invite/[token] — returns null for unknown tokens (never leak org existence). */
export async function previewInvite(token: string): Promise<InvitePreview | null> {
	const row = await inviteWithOrg(db, token);
	if (!row) return null;
	return {
		orgName: row.orgName,
		role: asInviteRole(token, row.role),
		expired: Date.parse(row.expiresAt) <= Date.now(),
		accepted: row.acceptedBy !== null
	};
}

/** Narrows a raw invites.role string, failing loudly on data bugs (never silently drop rows). */
function asInviteRole(token: string, role: string): 'admin' | 'member' {
	if (role === 'admin' || role === 'member') return role;
	throw new Error(`invite ${token} has unknown role: ${role}`);
}

/**
 * Accepts an invite: adds the membership when missing (already-a-member keeps
 * their role and just switches), burns the token, and points the session at
 * the new org. Everything happens in ONE transaction: the single-use check
 * and the burn are atomic, so two concurrent accepts can never both join —
 * and EVERY accept burns, so an already-a-member accept can never leave the
 * link usable by someone else (PR #52 review).
 */
export async function acceptInvite(
	userId: string,
	sessionToken: string,
	token: string
): Promise<{ orgId: string; session: { token: string; expiresAt: string } }> {
	return db.transaction(async (tx) => {
		const inv = await inviteWithOrg(tx, token);
		if (!inv || inv.acceptedBy !== null || Date.parse(inv.expiresAt) <= Date.now()) {
			throw error(410, 'this invite link is no longer valid — ask for a new one');
		}
		// createInvite blocks personal-org invites at write time; refuse any legacy
		// or hand-written row here too — personal teams can never gain members.
		if (inv.personalFor !== null) throw error(400, 'this invite points at a personal team — ask for a shared-team invite');
		const role = asInviteRole(token, inv.role);
		const existing = await tx
			.select({ role: memberships.role })
			.from(memberships)
			.where(and(eq(memberships.userId, userId), eq(memberships.orgId, inv.orgId)))
			.get();
		// Conditional claim: the burn only lands while accepted_by is still NULL,
		// so even read-skewed concurrent accepts can never both succeed.
		const claimed = await tx
			.update(invites)
			.set({ acceptedBy: userId })
			.where(and(eq(invites.token, token), isNull(invites.acceptedBy)))
			.returning({ token: invites.token });
		// Stryker disable next-line ConditionalExpression, StringLiteral: reachable only via a concurrent accept committing between the check above and this conditional claim — single-connection tests serialize transactions, so the zero-claim path cannot fire without a real race.
		if (claimed.length === 0) throw error(410, 'this invite link is no longer valid — ask for a new one');
		if (!existing) {
			await tx.insert(memberships).values({ userId, orgId: inv.orgId, role });
		}
		// Rotate the session ATOMICALLY with the burn: the pre-accept token dies
		// so it can never resolve at the joined org. Scoped AND verified — a
		// mismatched token rolls the whole accept back (the invite stays open).
		const session = await rotateSession(sessionToken, userId, inv.orgId, tx);
		return { orgId: inv.orgId, session };
	});
}

/** Switches the session's active org. Membership in the target is required. */
export async function switchActiveOrg(
	userId: string,
	sessionToken: string,
	orgId: string
): Promise<{ token: string; expiresAt: string }> {
	const m = await membershipOf(userId, orgId);
	if (!m) throw error(404, 'team not found');
	// Scoped AND verified (PR #52 review): rotateSession throws 401 for an
	// unknown or mismatched token instead of silently updating nothing — and
	// the rotation kills tokens minted before the switch so they can never
	// resolve at the target org.
	return rotateSession(sessionToken, userId, orgId);
}

export interface OrgMember {
	userId: string;
	displayName: string;
	role: OrgRole;
	isYou: boolean;
}

/** Member roster for the settings page, oldest membership first (ties by user id, in SQL). Caller must belong to the org. */
export async function listMembers(callerUserId: string, orgId: string): Promise<OrgMember[]> {
	const caller = await membershipOf(callerUserId, orgId);
	if (!caller) throw error(404, 'team not found');
	const rows = await db
		.select({ userId: users.id, displayName: users.displayName, role: memberships.role })
		.from(memberships)
		.innerJoin(users, eq(memberships.userId, users.id))
		.where(eq(memberships.orgId, orgId))
		.orderBy(memberships.createdAt, memberships.userId)
		.all();
	return rows.map((r) => ({ userId: r.userId, displayName: r.displayName, role: asOrgRole(r.role), isYou: r.userId === callerUserId }));
}

/** Open (unexpired, unaccepted) invites for the settings page. Caller must be admin+. */
export async function listOpenInvites(callerUserId: string, orgId: string) {
	const m = await membershipOf(callerUserId, orgId);
	if (!m) throw error(404, 'team not found');
	requireRole(asOrgRole(m.role), 'admin');
	const rows = await db
		.select({ token: invites.token, role: invites.role, expiresAt: invites.expiresAt })
		.from(invites)
		.where(and(eq(invites.orgId, orgId), isNull(invites.acceptedBy), gt(invites.expiresAt, new Date().toISOString())))
		.orderBy(invites.createdAt, invites.token)
		.all();
	return rows.map((r) => ({ token: r.token, role: asInviteRole(r.token, r.role), expiresAt: r.expiresAt }));
}

/**
 * Changes a member's role. Owner-only. Owners may promote to owner (multiple
 * owners are allowed); the LAST owner cannot be demoted. Self-demotion of the
 * last owner is blocked by the same rule.
 */
export async function setMemberRole(callerUserId: string, orgId: string, targetUserId: string, role: OrgRole): Promise<void> {
	const caller = await membershipOf(callerUserId, orgId);
	if (!caller) throw error(404, 'team not found');
	requireRole(asOrgRole(caller.role), 'owner');
	if (role !== 'owner' && role !== 'admin' && role !== 'member') throw error(400, 'unknown role');
	const target = await membershipOf(targetUserId, orgId);
	if (!target) throw error(404, 'member not found');
	// Demoting an owner is a CONDITIONAL update: the write only lands while
	// another owner still exists, so concurrent demotions can never strand the
	// org ownerless — no separate check to race with (PR #52 review).
	const demotingOwner = target.role === 'owner' && role !== 'owner';
	// The role update and the session invalidation commit TOGETHER (CodeRabbit
	// 3738037976): a failure deleting the target's sessions rolls the role
	// change back, so no pre-change token can outlive a promotion that never
	// landed. A same-role write is not a change and leaves sessions alone.
	await db.transaction(async (tx) => {
		const updated = await tx
			.update(memberships)
			.set({ role })
			.where(
				and(
					eq(memberships.userId, targetUserId),
					eq(memberships.orgId, orgId),
					demotingOwner
						? sql`(SELECT count(*) FROM memberships AS mo WHERE mo.org_id = ${orgId} AND mo.role = 'owner') > 1`
						: undefined
				)
			)
			.returning({ userId: memberships.userId });
		if (updated.length === 0) throw error(400, 'the last owner cannot be demoted — promote a teammate to owner first');
		// A role change must invalidate the target's sessions: roles resolve
		// live from memberships, so a token minted before the change would
		// instantly gain the new privilege. We cannot rotate tokens we do not
		// hold, so the target's rows are deleted — the next page load asks
		// them to sign in again (re-authentication on privilege change).
		if (target.role !== role) {
			await tx.delete(sessions).where(eq(sessions.userId, targetUserId));
		}
	});
}

/**
 * Removes a member. Admins remove members; only owners remove admins; owners
 * are never removed by others (they leave or the account is deleted). Nobody
 * removes themselves — that is leaveOrg.
 */
export async function removeMember(callerUserId: string, orgId: string, targetUserId: string): Promise<void> {
	if (callerUserId === targetUserId) throw error(400, 'use Leave team to remove yourself');
	const caller = await membershipOf(callerUserId, orgId);
	if (!caller) throw error(404, 'team not found');
	requireRole(asOrgRole(caller.role), 'admin');
	const target = await membershipOf(targetUserId, orgId);
	if (!target) throw error(404, 'member not found');
	if (target.role === 'owner') throw error(403, 'owners cannot be removed');
	if (target.role === 'admin' && caller.role !== 'owner') throw error(403, 'only an owner can remove an admin');
	await db.delete(memberships).where(and(eq(memberships.userId, targetUserId), eq(memberships.orgId, orgId)));
}

/**
 * Leaves an org. Blocked for the LAST owner while other members remain
 * (promote a successor first) and for the sole member (delete your account
 * instead — standalone org deletion is a non-goal).
 */
export async function leaveOrg(userId: string, sessionToken: string, orgId: string): Promise<void> {
	const m = await membershipOf(userId, orgId);
	if (!m) throw error(404, 'team not found');
	// Membership validation and the delete in ONE transaction; the delete is
	// additionally CONDITIONAL so concurrent leaves can never strand the org
	// without an owner even under read skew (PR #52 review).
	await db.transaction(async (tx) => {
		const others = await tx
			.select({ userId: memberships.userId, role: memberships.role })
			.from(memberships)
			.where(and(eq(memberships.orgId, orgId), ne(memberships.userId, userId)))
			.all();
		if (others.length === 0) throw error(400, 'you are the only member — delete your account to remove this team');
		// Stryker disable next-line ConditionalExpression, StringLiteral, BlockStatement: equivalent by design — the conditional DELETE below re-enforces the identical invariant atomically (role != 'owner' OR owner count > 1) and its empty-result throw carries the same 400 and message, so mutating this guard's condition or body is unobservable single-threaded; the guard is defense-in-depth so the error fires before the write attempt. (Also sweeps the predicate 'owner' StringLiteral, which the two-owner leave test kills.)
		if (m.role === 'owner' && !others.some((o) => o.role === 'owner')) {
			throw error(400, 'promote a teammate to owner before leaving');
		}
		const deleted = await tx
			.delete(memberships)
			.where(
				and(
					eq(memberships.userId, userId),
					eq(memberships.orgId, orgId),
					sql`(${memberships.role} != 'owner' OR (SELECT count(*) FROM memberships AS mo WHERE mo.org_id = ${orgId} AND mo.role = 'owner') > 1)`
				)
			)
			.returning({ userId: memberships.userId });
		// Stryker disable next-line ConditionalExpression, StringLiteral: race-only guard — the in-transaction owner check above plus this conditional delete cover every single-threaded path; an empty result needs a concurrent leave/demotion committing mid-transaction.
		if (deleted.length === 0) throw error(400, 'promote a teammate to owner before leaving');
		// If the session was acting in the org just left, clear active_org_id so
		// resolution falls back to the oldest remaining membership. Scoped to the
		// caller's own session (PR #52 review).
		await tx
			.update(sessions)
			.set({ activeOrgId: null })
			.where(and(eq(sessions.id, sessionToken), eq(sessions.userId, userId), eq(sessions.activeOrgId, orgId)));
	});
}
