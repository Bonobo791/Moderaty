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

import { beforeEach, expect, test, vi } from 'vitest';
import { error } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
	getSessionUser: vi.fn(),
	assertMigrationsCurrent: vi.fn(),
	cookieSecure: vi.fn(() => false)
}));

vi.mock('$lib/server/session', () => ({
	SESSION_COOKIE: 'moderaty_session',
	getSessionUser: mocks.getSessionUser
}));

vi.mock('$lib/server/oauthState', () => ({
	cookieSecure: mocks.cookieSecure
}));

vi.mock('$lib/server/migrationGuard', () => ({
	assertMigrationsCurrent: mocks.assertMigrationsCurrent
}));

import { handle } from './hooks.server';

beforeEach(() => {
	// Drop lingering console.error spies so per-test call assertions are clean.
	vi.restoreAllMocks();
	mocks.getSessionUser.mockReset();
	mocks.assertMigrationsCurrent.mockReset().mockResolvedValue(undefined);
	mocks.cookieSecure.mockReset().mockReturnValue(false);
});

function makeEvent() {
	return {
		cookies: { get: () => 'session-token', set: vi.fn() },
		locals: {} as { user: unknown; dbDown?: boolean },
		url: new URL('http://localhost/')
	};
}

test('a database failure during session lookup degrades to maintenance mode, never a bare 500', async () => {
	mocks.getSessionUser.mockRejectedValue(new Error('database is locked'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(event.locals.user).toBeNull();
	expect(event.locals.dbDown).toBe(true);
	// Loud on the server even though the user gets a maintenance page.
	expect(console.error).toHaveBeenCalled();
});

test('a resolved session user populates locals.user', async () => {
	mocks.getSessionUser.mockResolvedValue({
		user: { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' },
		renewed: false,
		expiresAt: '2026-08-01T00:00:00.000Z'
	});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(event.locals.user).toMatchObject({ id: 'user-1' });
});

test('a renewed session refreshes the cookie with the new expiry and security attributes', async () => {
	// Mutation audit: deleting the whole renewal branch stayed green — renewed
	// in the DB but stale in the browser logs active users out at the original
	// expiry. Attribute flips (httpOnly/sameSite) were equally invisible, and
	// hard-coding `secure` instead of calling cookieSecure() passed too — so
	// the test also asserts the helper is consulted.
	mocks.cookieSecure.mockReturnValue(true);
	mocks.getSessionUser.mockResolvedValue({
		user: { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' },
		renewed: true,
		expiresAt: '2026-09-01T00:00:00.000Z'
	});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(mocks.cookieSecure).toHaveBeenCalled();
	expect(event.cookies.set).toHaveBeenCalledWith('moderaty_session', 'session-token', {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: true,
		expires: new Date('2026-09-01T00:00:00.000Z')
	});
});

test('a database behind the code fails the request with the guard 503 before any session work', async () => {
	// error() throws by design — capture the HttpError it produces so the mock
	// rejects with the same instanceof the real guard throws.
	let guardError: unknown;
	try {
		error(503, 'the service is being upgraded — please retry in a few minutes');
	} catch (e) {
		guardError = e;
	}
	mocks.assertMigrationsCurrent.mockRejectedValue(guardError);
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await expect(handle({ event, resolve } as never)).rejects.toMatchObject({ status: 503 });
	expect(mocks.getSessionUser).not.toHaveBeenCalled();
	expect(resolve).not.toHaveBeenCalled();
});

test('a database failure inside the guard check degrades to maintenance mode, never a bare 500', async () => {
	mocks.assertMigrationsCurrent.mockRejectedValue(new Error('database is locked'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	// The session lookup is skipped — it would fail the same way.
	expect(mocks.getSessionUser).not.toHaveBeenCalled();
	expect(event.locals.user).toBeNull();
	expect(event.locals.dbDown).toBe(true);
	expect(console.error).toHaveBeenCalled();
});

test('/login still renders during a database outage (signed-out view, maintenance flagged)', async () => {
	mocks.getSessionUser.mockRejectedValue(new Error('database is locked'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = { ...makeEvent(), url: new URL('http://localhost/login') };
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(event.locals.user).toBeNull();
	expect(event.locals.dbDown).toBe(true);
});

test('/api/health bypasses the guard and session so a database outage still reaches the probe', async () => {
	// The probe's whole job is to report database health itself (issue #82):
	// the guard or the session lookup would convert an outage into a 500
	// before the endpoint could answer with its documented 503.
	mocks.assertMigrationsCurrent.mockRejectedValue(new Error('database is locked'));
	const event = { ...makeEvent(), url: new URL('http://localhost/api/health') };
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(mocks.assertMigrationsCurrent).not.toHaveBeenCalled();
	expect(mocks.getSessionUser).not.toHaveBeenCalled();
});

test('a deliberate HttpError from session resolution propagates — integrity failures are not outages', async () => {
	// getSessionUser throws error(500) for data-integrity failures (an account
	// with no organization). Degrading those to maintenance would mask
	// corruption as an outage and sign the user out; they must fail loudly.
	let integrity: unknown;
	try {
		error(500, 'account has no organization — contact support');
	} catch (e) {
		integrity = e;
	}
	mocks.getSessionUser.mockRejectedValue(integrity);
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await expect(handle({ event, resolve } as never)).rejects.toMatchObject({ status: 500 });
	expect(event.locals.dbDown).toBeUndefined();
	expect(resolve).not.toHaveBeenCalled();
});

test('no session resolves to signed-out without tripping the maintenance flag', async () => {
	// Mutation audit: dropping the optional chaining on `resolution?.user` /
	// `resolution?.renewed` turns a signed-out visitor into a TypeError that
	// the catch swallows as dbDown — every signed-out page would render the
	// maintenance overlay. Assert dbDown stays unset for the null resolution.
	mocks.getSessionUser.mockResolvedValue(null);
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(event.locals.user).toBeNull();
	expect(event.locals.dbDown).toBeUndefined();
	expect(errSpy).not.toHaveBeenCalled();
	expect(event.cookies.set).not.toHaveBeenCalled();
});

test('a non-renewed session does not rewrite the cookie', async () => {
	// Mutation audit: forcing the renewal condition true (or swapping && for
	// ||) re-sets the cookie on every request — harmless-looking but it
	// defeats the renewal-window design and hides real expiry behavior.
	mocks.getSessionUser.mockResolvedValue({
		user: { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' },
		renewed: false,
		expiresAt: '2026-08-01T00:00:00.000Z'
	});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(event.cookies.set).not.toHaveBeenCalled();
});

test('a renewed session without a cookie token does not rewrite the cookie', async () => {
	// The renewal branch must also require a token to write back — without a
	// cookie there is nothing to refresh.
	mocks.getSessionUser.mockResolvedValue({
		user: { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' },
		renewed: true,
		expiresAt: '2026-09-01T00:00:00.000Z'
	});
	const event = {
		cookies: { get: () => undefined, set: vi.fn() },
		locals: {} as { user: unknown; dbDown?: boolean },
		url: new URL('http://localhost/')
	};
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(event.cookies.set).not.toHaveBeenCalled();
});

test('a guard-check outage is logged with its identifiable message', async () => {
	// Mutation audit: blanking the log prefix makes ops pages ungreppable —
	// assert the exact loud message, not just that something was logged.
	mocks.assertMigrationsCurrent.mockRejectedValue(new Error('database is locked'));
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(errSpy).toHaveBeenCalledWith('migration guard query failed:', expect.any(Error));
});

test('a session-lookup outage is logged with its identifiable message', async () => {
	mocks.getSessionUser.mockRejectedValue(new Error('database is locked'));
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(errSpy).toHaveBeenCalledWith('session lookup failed:', expect.any(Error));
});
