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

import { cookieSecure, OAUTH_STATE_COOKIE, storePendingStates } from './oauthState';

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
	expect(() => cookieSecure()).toThrowError(expect.objectContaining({ status: 500 }));
});
