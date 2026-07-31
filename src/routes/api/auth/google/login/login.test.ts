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
	env: {
		GOOGLE_CLIENT_ID: 'client-id',
		GOOGLE_CLIENT_SECRET: 'client-secret',
		APP_URL: 'http://localhost:5173'
	} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { setupTestDb, testDb } from '$lib/server/testdb';
import { makeCookies, makeCookiesWithState } from '$lib/server/testcookies';
import { channels, sessions, users } from '$lib/server/db/schema';
import { GET as startLogin } from './+server';
import { GET as loginCallback } from './callback/+server';

setupTestDb(['sessions', 'users', 'channels']);

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function callbackUrl(params: Record<string, string>) {
	return new URL(`http://localhost:5173/api/auth/google/login/callback?${new URLSearchParams(params)}`);
}

function stubTokenAndUserinfo(userinfo: object, tokenStatus = 200) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') {
				return new Response(
					tokenStatus === 200 ? JSON.stringify({ access_token: 'google-access-token' }) : JSON.stringify({ error: 'invalid_grant' }),
					{ status: tokenStatus }
				);
			}
			if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
				return new Response(JSON.stringify(userinfo), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		})
	);
}

async function expectHttpError(promise: Promise<unknown>, status: number) {
	await expect(promise).rejects.toMatchObject({ status });
}

test('login start sets an HttpOnly oauth_state cookie and redirects with identity scopes and matching state', () => {
	const cookies = makeCookies();

	let location = '';
	try {
		startLogin({ cookies } as never);
	} catch (r) {
		location = (r as { location: string }).location;
	}

	const url = new URL(location);
	const stateCall = cookies.setCalls.find((c) => c.name === 'oauth_state');
	expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
	expect(url.searchParams.get('scope')).toBe('openid email profile');
	expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/auth/google/login/callback');
	expect(url.searchParams.get('state')).toBe(JSON.parse(stateCall!.value)[0]);
	expect(stateCall!.opts).toMatchObject({ httpOnly: true, sameSite: 'lax' });
});

test('login start fails loudly with 500 when GOOGLE_CLIENT_ID is not configured', () => {
	mocks.env.GOOGLE_CLIENT_ID = undefined;
	try {
		expect(() => startLogin({ cookies: makeCookies() } as never)).toThrow(
			expect.objectContaining({ status: 500 })
		);
	} finally {
		mocks.env.GOOGLE_CLIENT_ID = 'client-id';
	}
});

test('callback rejects a missing or mismatched state with 400', async () => {
	const cookies = makeCookiesWithState('known-state');
	await expectHttpError(loginCallback({ url: callbackUrl({ state: 'wrong', code: 'x' }), cookies } as never), 400);
});

test('callback rejects a missing code with 400', async () => {
	const cookies = makeCookiesWithState('known-state');
	await expectHttpError(loginCallback({ url: callbackUrl({ state: 'known-state' }), cookies } as never), 400);
});

test('callback returns 502 when the token exchange fails upstream', async () => {
	stubTokenAndUserinfo({}, 400);
	const cookies = makeCookiesWithState('s');
	await expectHttpError(loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never), 502);
});

test('callback returns 502 when userinfo fails', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') {
				return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
			}
			return new Response('nope', { status: 500 });
		})
	);
	const cookies = makeCookiesWithState('s');
	await expectHttpError(loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never), 502);
});

test('callback returns 502 when the userinfo request itself fails', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') {
				return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
			}
			throw new Error('socket hang up');
		})
	);
	const cookies = makeCookiesWithState('s');
	await expectHttpError(loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never), 502);
	expect(errorSpy.mock.calls.length > 0).toBe(true);
	// The state is not consumed on a transient failure — the only oauth_state
	// write is the initial seed, so the callback stays retryable.
	expect(cookies.setCalls.filter((c) => c.name === 'oauth_state')).toHaveLength(1);
});

test('callback returns 502 when userinfo has no usable sub claim', async () => {
	stubTokenAndUserinfo({ email: 'a@example.com' });
	const cookies = makeCookiesWithState('s');
	await expectHttpError(loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never), 502);
});

test('happy path creates the user and session, sets the cookie, consumes state, and redirects to the dashboard', async () => {
	stubTokenAndUserinfo({ sub: 'sub-1', email: 'one@example.com', name: 'One' });
	const cookies = makeCookiesWithState('s');

	await expect(loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never)).rejects.toMatchObject({
		status: 302,
		location: '/dashboard'
	});

	const created = await testDb().db.select().from(users).all();
	expect(created).toHaveLength(1);
	expect(created[0]).toMatchObject({ googleSub: 'sub-1', email: 'one@example.com', displayName: 'One', plan: 'free' });
	const createdSessions = await testDb().db.select().from(sessions).all();
	expect(createdSessions).toHaveLength(1);
	const sessionCall = cookies.setCalls.find((c) => c.name === 'moderaty_session');
	expect(sessionCall).toBeTruthy();
	expect(sessionCall!.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
	expect(sessionCall!.value).toBe(createdSessions[0].id);
	// State consumed on success (an empty pending list deletes the cookie).
	expect(cookies.get('oauth_state')).toBeUndefined();
});

test('only the first-ever user claims orphaned channels', async () => {
	await testDb().db.insert(channels).values({ id: 'UC1', title: 'Old', refreshTokenEnc: 'enc', active: 1, createdAt: '2026-01-01T00:00:00.000Z' });
	stubTokenAndUserinfo({ sub: 'sub-1', email: 'one@example.com', name: 'One' });
	await expect(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies: makeCookiesWithState('s') } as never)
	).rejects.toMatchObject({ status: 302 });
	expect((await testDb().db.select().from(channels).all())[0].userId).toBe(
		(await testDb().db.select().from(users).all())[0].id
	);

	// A second, distinct signup while another orphan exists must NOT claim it:
	// the claim is one-time initialization, not a per-signup action.
	await testDb().db.insert(channels).values({ id: 'UC2', title: 'Late', refreshTokenEnc: 'enc', active: 1, createdAt: '2026-01-01T00:00:00.000Z' });
	stubTokenAndUserinfo({ sub: 'sub-2', email: 'two@example.com', name: 'Two' });
	await expect(
		loginCallback({ url: callbackUrl({ state: 's2', code: 'y' }), cookies: makeCookiesWithState('s2') } as never)
	).rejects.toMatchObject({ status: 302 });

	expect((await testDb().db.select().from(channels).all()).find((c) => c.id === 'UC2')!.userId).toBeNull();
});

test('a repeat login with the same sub reuses the account', async () => {
	stubTokenAndUserinfo({ sub: 'sub-1', email: 'one@example.com', name: 'One' });
	const first = makeCookiesWithState('s1');
	await expect(loginCallback({ url: callbackUrl({ state: 's1', code: 'x' }), cookies: first } as never)).rejects.toMatchObject({ status: 302 });

	const second = makeCookiesWithState('s2');
	await expect(loginCallback({ url: callbackUrl({ state: 's2', code: 'y' }), cookies: second } as never)).rejects.toMatchObject({ status: 302 });

	expect(await testDb().db.select().from(users).all()).toHaveLength(1);
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(2);
});

test('the first-ever login claims orphaned pre-accounts channels', async () => {
	await testDb().db.insert(channels).values({ id: 'UC1', title: 'Old', refreshTokenEnc: 'enc', active: 1, createdAt: '2026-01-01T00:00:00.000Z' });
	stubTokenAndUserinfo({ sub: 'sub-1', email: 'one@example.com', name: 'One' });
	const cookies = makeCookiesWithState('s');

	await expect(loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never)).rejects.toMatchObject({ status: 302 });

	const claimed = await testDb().db.select().from(channels).all();
	const user = (await testDb().db.select().from(users).all())[0];
	expect(claimed[0].userId).toBe(user.id);
});

test('a later login does not steal channels owned by another user', async () => {
	stubTokenAndUserinfo({ sub: 'sub-1', email: 'one@example.com', name: 'One' });
	await expect(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies: makeCookiesWithState('s') } as never)
	).rejects.toMatchObject({ status: 302 });
	const owner = (await testDb().db.select().from(users).all())[0];
	await testDb().db.insert(channels).values({ id: 'UC2', userId: owner.id, title: 'Owned', refreshTokenEnc: 'enc', active: 1, createdAt: '2026-01-01T00:00:00.000Z' });

	stubTokenAndUserinfo({ sub: 'sub-2', email: 'two@example.com', name: 'Two' });
	await expect(
		loginCallback({ url: callbackUrl({ state: 's2', code: 'y' }), cookies: makeCookiesWithState('s2') } as never)
	).rejects.toMatchObject({ status: 302 });

	const channel = (await testDb().db.select().from(channels).all()).find((c) => c.id === 'UC2');
	expect(channel!.userId).toBe(owner.id);
});
