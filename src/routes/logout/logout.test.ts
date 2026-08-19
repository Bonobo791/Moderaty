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

import { expect, test, vi } from 'vitest';

import { setupTestDb, testDb } from '$lib/server/testdb';
import { makeCookies } from '$lib/server/testcookies';
import { sessions, users } from '$lib/server/db/schema';
import { createSession, SESSION_COOKIE } from '$lib/server/session';

import { actions, load } from './+page.server';

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

test('GET /logout always redirects to the login page', () => {
	// Logout is a form post; a plain GET (bookmark, prefetch, history nav) must
	// never render a page — it bounces to /login.
	let thrown: unknown;
	try {
		load({} as Parameters<typeof load>[0]);
	} catch (e) {
		thrown = e;
	}
	expect(thrown).toMatchObject({ status: 302, location: '/login' });
});

test('logout with no session cookie clears and redirects without a session sweep', async () => {
	// Nothing in the jar means destroySession must not run at all — an
	// unconditional sweep would hit the database with an undefined token and
	// the logout would fail instead of redirecting.
	const cookies = makeCookies();

	const thrown = await captureLogout(cookies, OWNER);

	expect(thrown).toMatchObject({ status: 302, location: '/login' });
	expect(cookies.deleteCalls).toEqual([{ name: SESSION_COOKIE, opts: { path: '/' } }]);
});

/** Makes the next (and every) session-row DELETE fail until restored. */
async function breakSessionDeletes() {
	await testDb().client.execute(
		`CREATE TRIGGER mt_fail_session_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'simulated session store outage'); END`
	);
}

async function restoreSessionDeletes() {
	await testDb().client.execute('DROP TRIGGER mt_fail_session_delete');
}

test('logout rethrows a session sweep failure outside an outage — cookie stays, no redirect', async () => {
	await testDb().db.insert(users).values({ id: OWNER.id, googleSub: 'sub-1', email: OWNER.email, displayName: OWNER.displayName });
	const { token } = await createSession(OWNER.id);
	const cookies = makeCookies();
	cookies.set(SESSION_COOKIE, token, { path: '/' });
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	await breakSessionDeletes();
	try {
		const thrown = await captureLogout(cookies, OWNER);

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as unknown as Error).message).toContain('Failed query');
		expect(thrown).not.toMatchObject({ status: 302 });
		expect(cookies.deleteCalls).toHaveLength(0);
		expect(cookies.get(SESSION_COOKIE)).toBe(token);
		expect(errorSpy).not.toHaveBeenCalled();
		const remaining = await testDb().db.select().from(sessions);
		expect(remaining).toHaveLength(1);
	} finally {
		errorSpy.mockRestore();
		await restoreSessionDeletes();
	}
});

test('logout during an outage swallows a session sweep failure — loudly — and still signs out', async () => {
	// A real session row is needed so the failing sweep actually runs — a
	// DELETE that matches zero rows never touches the broken store.
	await testDb().db.insert(users).values({ id: OWNER.id, googleSub: 'sub-1', email: OWNER.email, displayName: OWNER.displayName });
	const { token } = await createSession(OWNER.id);
	const cookies = makeCookies();
	cookies.set(SESSION_COOKIE, token, { path: '/' });
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	await breakSessionDeletes();
	try {
		const thrown = await captureLogout(cookies, null, true);

		expect(thrown).toMatchObject({ status: 302, location: '/login' });
		expect(cookies.deleteCalls).toEqual([{ name: SESSION_COOKIE, opts: { path: '/' } }]);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(
			'logout during outage could not destroy the session row:',
			expect.any(Error)
		);
	} finally {
		errorSpy.mockRestore();
		await restoreSessionDeletes();
	}
});
