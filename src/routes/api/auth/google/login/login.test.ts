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
		APP_URL: 'http://localhost:5173',
		ENCRYPTION_KEY: 'test-encryption-key'
	} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { setupTestDb, testDb } from '$lib/server/testdb';
import { makeCookies, makeCookiesWithState } from '$lib/server/testcookies';
import { consents, sessions, users } from '$lib/server/db/schema';
import { LEGAL_VERSION, PENDING_CONSENT_COOKIE, readPendingConsent } from '$lib/server/legal';
import { GET as startLogin } from './+server';
import { GET as loginCallback } from './callback/+server';

setupTestDb(['consents', 'sessions', 'users', 'channels']);

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

/** Stubs a successful token exchange; `onUserinfo` handles the userinfo call. */
function stubTokenOkThen(onUserinfo: () => Response) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === 'https://oauth2.googleapis.com/token') {
				return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
			}
			return onUserinfo();
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
	stubTokenOkThen(() => new Response('nope', { status: 500 }));
	const cookies = makeCookiesWithState('s');
	await expectHttpError(loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never), 502);
});

test('callback returns 502 when the userinfo request itself fails', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenOkThen(() => {
		throw new Error('socket hang up');
	});
	const cookies = makeCookiesWithState('s');
	await expectHttpError(loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never), 502);
	expect(errorSpy).toHaveBeenCalled();
	// The state is not consumed on a transient failure — the only oauth_state
	// write is the initial seed, so the callback stays retryable.
	expect(cookies.setCalls.filter((c) => c.name === 'oauth_state')).toHaveLength(1);
});

test('callback returns 502 when userinfo has no usable sub claim', async () => {
	stubTokenAndUserinfo({ email: 'a@example.com' });
	const cookies = makeCookiesWithState('s');
	await expectHttpError(loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never), 502);
});

async function seedConsentedUser(sub: string, docVersion: string = LEGAL_VERSION) {
	const userId = `user-${sub}`;
	await testDb().db.insert(users).values({ id: userId, googleSub: sub, email: `${sub}@example.com`, displayName: sub });
	await testDb().db.insert(consents).values({
		userId,
		docVersion,
		checkboxText: 'previously accepted',
		ip: '127.0.0.1',
		userAgent: 'test'
	});
	return userId;
}

const userRows = () => testDb().db.select().from(users).all();
const sessionRows = () => testDb().db.select().from(sessions).all();

/** Stubs Google's token+userinfo for sub-1, runs the login callback, and
 *  returns the 302 target plus the cookie jar for assertions. */
async function signIn(state = 's') {
	stubTokenAndUserinfo({ sub: 'sub-1', email: 'one@example.com', name: 'One' });
	const cookies = makeCookiesWithState(state);
	const redirect: unknown = await loginCallback({ url: callbackUrl({ state, code: 'x' }), cookies } as never).catch(
		(e: unknown) => e
	);
	expect(redirect).toMatchObject({ status: 302 });
	return { cookies, location: (redirect as { location: string }).location };
}

test('callback with a new identity parks a pending consent and redirects to /consent without creating anything', async () => {
	const { cookies, location } = await signIn();

	expect(location).toBe('/consent?state=s');
	// The contract forms at the /consent checkbox — no account, no session yet.
	expect(await userRows()).toHaveLength(0);
	expect(await sessionRows()).toHaveLength(0);
	const pendingCall = cookies.setCalls.find((c) => c.name === PENDING_CONSENT_COOKIE);
	expect(pendingCall).toBeTruthy();
	expect(pendingCall!.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
	// The parked identity is keyed by this flow's state, so concurrent tabs
	// signing into different accounts cannot overwrite one another.
	expect(readPendingConsent(cookies as never, 's')).toEqual({
		kind: 'new',
		sub: 'sub-1',
		email: 'one@example.com',
		displayName: 'One'
	});
	// State consumed — the OAuth leg completed successfully.
	expect(cookies.get('oauth_state')).toBeUndefined();
});

test('callback with a consented existing user creates a session and redirects to the dashboard', async () => {
	const userId = await seedConsentedUser('sub-1');
	const { cookies, location } = await signIn();

	expect(location).toBe('/dashboard');
	const createdSessions = await sessionRows();
	expect(createdSessions).toHaveLength(1);
	expect(createdSessions[0].userId).toBe(userId);
	const sessionCall = cookies.setCalls.find((c) => c.name === 'moderaty_session');
	expect(sessionCall).toBeTruthy();
	expect(sessionCall!.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
	expect(sessionCall!.value).toBe(createdSessions[0].id);
	// State consumed on success (an empty pending list deletes the cookie).
	expect(cookies.get('oauth_state')).toBeUndefined();
});

test('callback with an existing user on a stale document version sends them back through /consent', async () => {
	await seedConsentedUser('sub-1', 'v0.9');
	const { location } = await signIn();

	expect(location).toBe('/consent?state=s');
	expect(await sessionRows()).toHaveLength(0);
});

test('a repeat login with the same sub reuses the account', async () => {
	await seedConsentedUser('sub-1');
	expect((await signIn('s1')).location).toBe('/dashboard');
	expect((await signIn('s2')).location).toBe('/dashboard');

	expect(await userRows()).toHaveLength(1);
	expect(await sessionRows()).toHaveLength(2);
});

test('a deleted account\'s freed Google sub starts a fresh signup through /consent', async () => {
	// Deletion is immediate and permanent: the tombstone keeps
	// googleSub 'deleted:<id>', so the real sub no longer resolves to anyone.
	// Signing back in is a brand-new signup, never a restore.
	await testDb()
		.db.insert(users)
		.values({ id: 'old', googleSub: 'deleted:old', email: '[deleted]', displayName: '[deleted]' });
	const { location } = await signIn();

	expect(location).toBe('/consent?state=s');
	// No session, no account created before the /consent checkbox.
	expect(await sessionRows()).toHaveLength(0);
	expect(await userRows()).toHaveLength(1); // just the untouched tombstone
});
