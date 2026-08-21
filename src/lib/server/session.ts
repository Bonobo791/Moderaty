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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

// DIY cookie sessions — no auth library, per the project's dependency policy.
// A session is a random 32-byte token stored in the `sessions` table and sent
// as an httpOnly cookie; expiry slides while the user stays active.

import { randomBytes } from 'node:crypto';

import { error } from '@sveltejs/kit';
import { and, eq, lte } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { sessions, users } from '$lib/server/db/schema';
import { resolveActiveOrg, type OrgRole } from '$lib/server/org';

export const SESSION_COOKIE = 'moderaty_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Renew when under 15 days remain. Exported so the property tests can pin the
// sliding-expiry boundary against the production threshold instead of
// re-deriving it (review deferral #3).
export const RENEW_BELOW_MS = SESSION_TTL_MS / 2;

export interface SessionUser {
	id: string;
	email: string;
	displayName: string;
	plan: string; // the ACTIVE ORGANIZATION's plan — billing is per-org; users.plan is legacy
	orgId: string;
	orgName: string;
	orgRole: OrgRole;
}

export interface SessionResolution {
	user: SessionUser;
	expiresAt: string;
	renewed: boolean;
}

/**
 * Creates a session for a user and returns its cookie token and expiry.
 * Callers that must commit the session atomically with other writes (e.g.
 * account creation) pass their transaction as `handle`.
 */
export async function createSession(
	userId: string,
	handle: Pick<typeof db, 'delete' | 'insert'> = db,
	activeOrgId: string | null = null
): Promise<{ token: string; expiresAt: string }> {
	// Opportunistic cleanup: logins are infrequent, so this bounds the expired-row
	// buildup for users who never come back (lazy per-token delete can't catch those).
	const now = new Date();
	await handle.delete(sessions).where(lte(sessions.expiresAt, now.toISOString()));
	const token = randomBytes(32).toString('hex');
	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
	await handle.insert(sessions).values({ id: token, userId, expiresAt, activeOrgId });
	return { token, expiresAt };
}

/**
 * Resolves a session cookie token to its user, or null when unknown or
 * expired. Expired rows are deleted lazily on read; sessions in their last 15
 * days are renewed in place (sliding expiry) and reported via `renewed` so
 * the caller can refresh the cookie.
 */
export async function getSessionUser(token: string | undefined): Promise<SessionResolution | null> {
	if (!token) return null;
	const row = await db
		.select({
			session: sessions,
			user: { id: users.id, email: users.email, displayName: users.displayName },
			userGoogleSub: users.googleSub
		})
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(eq(sessions.id, token))
		.get();
	if (!row) return null;
	// A session that outlives account deletion (e.g. a login callback read the
	// user just before the deletion transaction committed, then created this
	// session after every session was deleted) must never resolve: destroy it
	// so a deleted account has no working credentials. The tombstone marker is
	// googleSub = 'deleted:<id>'.
	if (row.userGoogleSub.startsWith('deleted:')) {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.info(`session for deleted account ${row.user.id} destroyed on resolution`);
		await db.delete(sessions).where(eq(sessions.id, token));
		return null;
	}
	const expiresMs = Date.parse(row.session.expiresAt);
	if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
		await db.delete(sessions).where(eq(sessions.id, token));
		return null;
	}
	// Tenant resolution: the session's active org when the membership still
	// exists, else the user's oldest membership (and the session row is
	// repaired). Zero memberships is a data bug — fail loudly, never sign out.
	const resolved = await resolveActiveOrg(row.user.id, row.session.activeOrgId);
	if (!resolved) {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.error(`user ${row.user.id} has no organization membership`);
		// HttpError, not a plain Error: hooks rethrows deliberate HttpErrors so
		// this data bug fails loudly instead of degrading to maintenance mode.
		throw error(500, 'account has no organization — contact support');
	}
	// Org repair and sliding-expiry renewal are one UPDATE when both apply.
	const updates: { activeOrgId?: string; expiresAt?: string } = {};
	// Stryker disable next-line ConditionalExpression: equivalent — resolveActiveOrg (org.ts) only reports fellBack when activeOrgId !== null, so the second conjunct is redundant defense-in-depth; the LogicalOperator on this line is killed by the no-fallback-log test
	if (resolved.fellBack && row.session.activeOrgId !== null) {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.info(`session for user ${row.user.id}: active org ${row.session.activeOrgId} no longer valid, falling back to ${resolved.org.orgId}`);
		updates.activeOrgId = resolved.org.orgId;
	}
	const user = { ...row.user, plan: resolved.org.plan, orgId: resolved.org.orgId, orgName: resolved.org.orgName, orgRole: resolved.org.orgRole };
	if (expiresMs - Date.now() < RENEW_BELOW_MS) {
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
		updates.expiresAt = expiresAt;
		await db.update(sessions).set(updates).where(eq(sessions.id, token));
		return { user, expiresAt, renewed: true };
	}
	if (updates.activeOrgId) {
		await db.update(sessions).set(updates).where(eq(sessions.id, token));
	}
	return { user, expiresAt: row.session.expiresAt, renewed: false };
}

/** Deletes a session (sign-out). Unknown tokens are a no-op. */
export async function destroySession(token: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, token));
}

/**
 * Rotates a session after a privilege-context change (org switch, invite
 * accept): the old token dies and a fresh one is issued for the same user and
 * expiry, so a token minted under the weaker context stops working the moment
 * the change lands. The caller must write the new token into the response
 * cookie. Scoped to the caller's own session (PR #52 pattern): an unknown or
 * mismatched token throws 401 instead of silently minting a replacement.
 */
export async function rotateSession(
	oldToken: string,
	userId: string,
	activeOrgId: string | null,
	handle: Pick<typeof db, 'select' | 'delete' | 'insert'> = db
): Promise<{ token: string; expiresAt: string }> {
	const row = await handle
		.select({ expiresAt: sessions.expiresAt })
		.from(sessions)
		.where(and(eq(sessions.id, oldToken), eq(sessions.userId, userId)))
		.get();
	if (!row) throw error(401, 'sign-in required');
	const token = randomBytes(32).toString('hex');
	// Delete + insert: the stolen old token is dead even if this call crashes
	// before the insert lands (fail-closed — the user re-signs-in). Rotation
	// preserves the remaining expiry — it must not extend the session.
	await handle.delete(sessions).where(eq(sessions.id, oldToken));
	await handle.insert(sessions).values({ id: token, userId, expiresAt: row.expiresAt, activeOrgId });
	return { token, expiresAt: row.expiresAt };
}

/**
 * Returns the signed-in user or throws 401. Page loads under (app) are
 * already redirected to /login by the layout guard; this is the backstop for
 * form actions, which must never run unauthenticated.
 */
export function requireUser(locals: { user: SessionUser | null }): SessionUser {
	if (!locals.user) throw error(401, 'sign-in required');
	return locals.user;
}
