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

import { eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { memberships, organizations } from '$lib/server/db/schema';

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
