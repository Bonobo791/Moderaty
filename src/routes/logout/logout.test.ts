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

import { expect, test } from 'vitest';

import { setupTestDb, testDb } from '$lib/server/testdb';
import { makeCookies } from '$lib/server/testcookies';
import { sessions, users } from '$lib/server/db/schema';
import { createSession, SESSION_COOKIE } from '$lib/server/session';

import { actions } from './+page.server';

setupTestDb(['sessions', 'users']);

const OWNER = { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' };

async function captureLogout(cookies: ReturnType<typeof makeCookies>, user: typeof OWNER | null, dbDown = false) {
	try {
		await actions.default({ cookies, locals: { user, dbDown } } as never);
		return undefined;
	} catch (e) {
		return e as { status: number; location?: string };
	}
}

test('logout rejects a signed-out request with 401 and leaves cookies alone', async () => {
	const cookies = makeCookies();

	const thrown = await captureLogout(cookies, null);

	expect(thrown?.status).toBe(401);
	expect(cookies.deleteCalls).toHaveLength(0);
});

test('logout during a database outage clears the cookie and redirects — never a 401', async () => {
	// The session lookup failed in hooks, so locals.user is null; requiring a
	// user here would 401 and strand the session cookie with no recovery path.
	// The UI offers logout precisely so the browser can forget the session
	// while the DB is down.
	const cookies = makeCookies();
	cookies.set(SESSION_COOKIE, 'stale-token', { path: '/' });

	const thrown = await captureLogout(cookies, null, true);

	expect(thrown).toMatchObject({ status: 302, location: '/login' });
	expect(cookies.deleteCalls).toEqual([{ name: SESSION_COOKIE, opts: { path: '/' } }]);
});

test('logout destroys the session row and clears the cookie', async () => {
	await testDb().db.insert(users).values({ id: OWNER.id, googleSub: 'sub-1', email: OWNER.email, displayName: OWNER.displayName });
	const { token } = await createSession(OWNER.id);
	const cookies = makeCookies();
	cookies.set(SESSION_COOKIE, token, { path: '/' });

	const thrown = await captureLogout(cookies, OWNER);

	expect(thrown).toMatchObject({ status: 302, location: '/login' });
	expect(cookies.deleteCalls).toEqual([{ name: SESSION_COOKIE, opts: { path: '/' } }]);
	expect(cookies.get(SESSION_COOKIE)).toBeUndefined();
	const remaining = await testDb().db.select().from(sessions);
	expect(remaining).toHaveLength(0);
});
