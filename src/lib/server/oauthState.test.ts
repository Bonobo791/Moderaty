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

import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: { APP_URL: 'https://moderaty.example' } as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { cookieSecure, OAUTH_STATE_COOKIE, readPendingStates, storePendingStates } from './oauthState';

afterEach(() => {
	mocks.env.APP_URL = 'https://moderaty.example';
});

function fakeCookies() {
	return { set: vi.fn(), get: vi.fn(), delete: vi.fn(), getAll: vi.fn(), serialize: vi.fn() };
}

test('marks the OAuth state cookie Secure when APP_URL is https', () => {
	// Mutation audit: inverting cookieSecure() stayed green — every cookie
	// assertion in the suite uses toMatchObject without `secure`, and the test
	// env's APP_URL is http. In production the state cookie (the CSRF guard)
	// would silently lose Secure and travel over plain HTTP.
	const cookies = fakeCookies();

	storePendingStates(cookies as never, ['state-1']);

	expect(cookies.set).toHaveBeenCalledWith(
		OAUTH_STATE_COOKIE,
		JSON.stringify(['state-1']),
		expect.objectContaining({ path: '/', httpOnly: true, sameSite: 'lax', secure: true })
	);
});

test('derives Secure from APP_URL and fails loudly when it is missing', () => {
	expect(cookieSecure()).toBe(true);

	mocks.env.APP_URL = 'http://localhost:5173';
	expect(cookieSecure()).toBe(false);

	delete mocks.env.APP_URL;
	expect(() => cookieSecure()).toThrowError(
		expect.objectContaining({ status: 500, body: { message: 'APP_URL is not configured' } })
	);
});

test('fails loudly when APP_URL is http in the production deployment — auth cookies must never ship insecure', () => {
	// The Secure flag derives from APP_URL; a misconfigured production APP_URL
	// would otherwise silently drop Secure from every session/consent/pick
	// cookie. Production is detected from the Netlify CONTEXT (set only on the
	// production deploy) or NODE_ENV — dev and previews keep http allowed.
	mocks.env.APP_URL = 'http://moderaty.example';
	mocks.env.CONTEXT = 'production';
	expect(() => cookieSecure()).toThrowError(
		expect.objectContaining({ status: 500, body: { message: 'APP_URL must be https in the production deployment' } })
	);

	// Same http APP_URL outside production stays allowed (local dev needs it).
	delete mocks.env.CONTEXT;
	mocks.env.APP_URL = 'http://localhost:5173';
	expect(cookieSecure()).toBe(false);

	// NODE_ENV=production is the self-hosted fallback discriminator — the same
	// http APP_URL must fail loudly there too (CodeRabbit 3738037962).
	mocks.env.NODE_ENV = 'production';
	expect(() => cookieSecure()).toThrowError(
		expect.objectContaining({ status: 500, body: { message: 'APP_URL must be https in the production deployment' } })
	);
	delete mocks.env.NODE_ENV;

	// https is fine in production.
	mocks.env.APP_URL = 'https://moderaty.example';
	mocks.env.CONTEXT = 'production';
	expect(cookieSecure()).toBe(true);
	delete mocks.env.CONTEXT;
});

test('reads back the pending states stored in the cookie', () => {
	const cookies = fakeCookies();
	cookies.get.mockReturnValue(JSON.stringify(['state-1', 'state-2']));

	expect(readPendingStates(cookies as never)).toEqual(['state-1', 'state-2']);
	expect(cookies.get).toHaveBeenCalledWith(OAUTH_STATE_COOKIE);
});

test('reads an absent cookie as no pending states', () => {
	const cookies = fakeCookies();
	cookies.get.mockReturnValue(undefined);

	expect(readPendingStates(cookies as never)).toEqual([]);
});

test('reads a non-array cookie payload as no pending states', () => {
	const cookies = fakeCookies();
	cookies.get.mockReturnValue(JSON.stringify({ state: 'state-1' }));

	expect(readPendingStates(cookies as never)).toEqual([]);
});

test('reads malformed JSON as no pending states', () => {
	const cookies = fakeCookies();
	cookies.get.mockReturnValue('{not json');

	expect(readPendingStates(cookies as never)).toEqual([]);
});

test('drops non-string entries from the stored pending states', () => {
	const cookies = fakeCookies();
	cookies.get.mockReturnValue(JSON.stringify(['state-1', 42, null, 'state-2', { s: 1 }, ['state-3']]));

	expect(readPendingStates(cookies as never)).toEqual(['state-1', 'state-2']);
});

test('deletes the state cookie at path / when no states remain', () => {
	const cookies = fakeCookies();

	storePendingStates(cookies as never, []);

	expect(cookies.delete).toHaveBeenCalledWith(OAUTH_STATE_COOKIE, { path: '/' });
	expect(cookies.set).not.toHaveBeenCalled();
});

test('keeps only the newest MAX_PENDING_STATES states', () => {
	const cookies = fakeCookies();

	storePendingStates(cookies as never, ['s1', 's2', 's3', 's4', 's5', 's6', 's7']);

	expect(cookies.set).toHaveBeenCalledWith(
		OAUTH_STATE_COOKIE,
		JSON.stringify(['s3', 's4', 's5', 's6', 's7']),
		expect.objectContaining({ path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 600 })
	);
});
