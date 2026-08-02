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

// DIY cookie sessions — no auth library, per the project's dependency policy.
// A session is a random 32-byte token stored in the `sessions` table and sent
// as an httpOnly cookie; expiry slides while the user stays active.

import { randomBytes } from 'node:crypto';

import { error } from '@sveltejs/kit';
import { eq, lte } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { sessions, users } from '$lib/server/db/schema';

export const SESSION_COOKIE = 'moderaty_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RENEW_BELOW_MS = SESSION_TTL_MS / 2; // renew when under 15 days remain

export interface SessionUser {
	id: string;
	email: string;
	displayName: string;
	plan: string;
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
	handle: Pick<typeof db, 'delete' | 'insert'> = db
): Promise<{ token: string; expiresAt: string }> {
	// Opportunistic cleanup: logins are infrequent, so this bounds the expired-row
	// buildup for users who never come back (lazy per-token delete can't catch those).
	const now = new Date();
	await handle.delete(sessions).where(lte(sessions.expiresAt, now.toISOString()));
	const token = randomBytes(32).toString('hex');
	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
	await handle.insert(sessions).values({ id: token, userId, expiresAt });
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
			user: { id: users.id, email: users.email, displayName: users.displayName, plan: users.plan },
			userDeletedAt: users.deletedAt
		})
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(eq(sessions.id, token))
		.get();
	if (!row) return null;
	// A session that outlives account deletion (e.g. a login callback read the
	// user just before the deletion transaction committed, then created this
	// session after every session was deleted) must never resolve: destroy it
	// so a soft-deleted account has no working credentials.
	if (row.userDeletedAt) {
		console.info(`session for soft-deleted account ${row.user.id} destroyed on resolution`);
		await db.delete(sessions).where(eq(sessions.id, token));
		return null;
	}
	const expiresMs = Date.parse(row.session.expiresAt);
	if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
		await db.delete(sessions).where(eq(sessions.id, token));
		return null;
	}
	if (expiresMs - Date.now() < RENEW_BELOW_MS) {
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
		await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, token));
		return { user: row.user, expiresAt, renewed: true };
	}
	return { user: row.user, expiresAt: row.session.expiresAt, renewed: false };
}

/** Deletes a session (sign-out). Unknown tokens are a no-op. */
export async function destroySession(token: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, token));
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
