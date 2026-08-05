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
	mocks.getSessionUser.mockReset();
	mocks.assertMigrationsCurrent.mockReset().mockResolvedValue(undefined);
	mocks.cookieSecure.mockReset().mockReturnValue(false);
});

function makeEvent() {
	return {
		cookies: { get: () => 'session-token', set: vi.fn() },
		locals: {} as { user: unknown },
		url: new URL('http://localhost/')
	};
}

test('a database failure during session lookup fails loudly with a user-visible 500', async () => {
	mocks.getSessionUser.mockRejectedValue(new Error('database is locked'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await expect(handle({ event, resolve } as never)).rejects.toMatchObject({ status: 500 });
	expect(resolve).not.toHaveBeenCalled();
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

test('a database failure inside the guard check fails loudly with a user-visible 500', async () => {
	mocks.assertMigrationsCurrent.mockRejectedValue(new Error('database is locked'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await expect(handle({ event, resolve } as never)).rejects.toMatchObject({ status: 500 });
	expect(mocks.getSessionUser).not.toHaveBeenCalled();
	expect(resolve).not.toHaveBeenCalled();
});
