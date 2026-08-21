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

async function expectHttpError(promise: Promise<unknown>, status: number, message?: string) {
	const matcher: Record<string, unknown> = { status };
	if (message !== undefined) matcher.body = { message };
	await expect(promise).rejects.toMatchObject(matcher);
}

/** The fetch mock installed by the stubs, for inspecting outgoing calls. */
function fetchMock() {
	return fetch as unknown as ReturnType<typeof vi.fn>;
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
	expect(url.searchParams.get('client_id')).toBe('client-id');
	expect(url.searchParams.get('response_type')).toBe('code');
	expect(url.searchParams.get('scope')).toBe('openid email profile');
	expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/auth/google/login/callback');
	expect(url.searchParams.get('state')).toBe(JSON.parse(stateCall!.value)[0]);
	expect(stateCall!.opts).toMatchObject({ httpOnly: true, sameSite: 'lax' });
});

test('login start fails loudly with 500 when GOOGLE_CLIENT_ID is not configured', () => {
	mocks.env.GOOGLE_CLIENT_ID = undefined;
	try {
		expect(() => startLogin({ cookies: makeCookies() } as never)).toThrow(
			expect.objectContaining({ status: 500, body: { message: 'GOOGLE_CLIENT_ID is not configured' } })
		);
	} finally {
		mocks.env.GOOGLE_CLIENT_ID = 'client-id';
	}
});

test('login start fails loudly with 500 when APP_URL is not configured', () => {
	mocks.env.APP_URL = undefined;
	try {
		expect(() => startLogin({ cookies: makeCookies() } as never)).toThrow(
			expect.objectContaining({ status: 500, body: { message: 'APP_URL is not configured' } })
		);
	} finally {
		mocks.env.APP_URL = 'http://localhost:5173';
	}
});

test('callback rejects a missing or mismatched state with 400', async () => {
	const cookies = makeCookiesWithState('known-state');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 'wrong', code: 'x' }), cookies } as never),
		400,
		'bad state'
	);
	await expectHttpError(
		loginCallback({ url: callbackUrl({ code: 'x' }), cookies } as never),
		400,
		'bad state'
	);
});

test('callback rejects a missing code with 400', async () => {
	const cookies = makeCookiesWithState('known-state');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 'known-state' }), cookies } as never),
		400,
		'missing code'
	);
});

test('callback returns 502 when the token exchange fails upstream', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenAndUserinfo({}, 400);
	const cookies = makeCookiesWithState('s');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
		502,
		'Google sign-in failed — please retry'
	);
	expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
		'google login token exchange'
	);
});

test('callback exchanges the code against the registered login callback redirect_uri', async () => {
	stubTokenAndUserinfo({ sub: 'sub-1' });
	const cookies = makeCookiesWithState('s');
	await loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never).catch(
		() => {}
	);
	const tokenCall = fetchMock().mock.calls.find(
		([input]) => String(input) === 'https://oauth2.googleapis.com/token'
	);
	expect(tokenCall, 'token exchange must be called').toBeDefined();
	const body = new URLSearchParams(String((tokenCall![1] as { body: unknown }).body));
	expect(body.get('redirect_uri')).toBe('http://localhost:5173/api/auth/google/login/callback');
});

test('callback authorizes the userinfo lookup with the exchanged access token', async () => {
	stubTokenAndUserinfo({ sub: 'sub-1' });
	const cookies = makeCookiesWithState('s');
	await loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never).catch(
		() => {}
	);
	const userinfoCall = fetchMock().mock.calls.find(
		([input]) => String(input) === 'https://openidconnect.googleapis.com/v1/userinfo'
	);
	expect(userinfoCall, 'userinfo lookup must be called').toBeDefined();
	const init = userinfoCall![1] as { headers: Record<string, string> };
	expect(init.headers.Authorization).toBe('Bearer google-access-token');
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
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
		502,
		'Google sign-in failed — please retry'
	);
	expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
		'google userinfo request failed'
	);
	// The state is not consumed on a transient failure — the only oauth_state
	// write is the initial seed, so the callback stays retryable.
	expect(cookies.setCalls.filter((c) => c.name === 'oauth_state')).toHaveLength(1);
});

test('callback rejects a non-OK userinfo response even when its body is valid JSON', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenOkThen(
		() =>
			new Response(JSON.stringify({ sub: 'sub-1', email: 'one@example.com', name: 'One' }), {
				status: 500
			})
	);
	const cookies = makeCookiesWithState('s');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
		502,
		'Google sign-in failed — please retry'
	);
	expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
		'google userinfo lookup failed: 500'
	);
	// The identity is never trusted: no session, no parked consent.
	expect(await sessionRows()).toHaveLength(0);
	expect(cookies.get(PENDING_CONSENT_COOKIE)).toBeUndefined();
});

test('callback returns 502 when the userinfo body is not valid JSON', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenOkThen(() => new Response('this is not json', { status: 200 }));
	const cookies = makeCookiesWithState('s');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
		502,
		'invalid response from Google — please retry'
	);
	expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
		'google userinfo returned invalid JSON'
	);
});

test('callback returns 502 when the userinfo JSON is null', async () => {
	stubTokenOkThen(() => new Response('null', { status: 200 }));
	const cookies = makeCookiesWithState('s');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
		502,
		'invalid response from Google — please retry'
	);
});

test('callback returns 502 when the sub claim is an empty string', async () => {
	stubTokenAndUserinfo({ sub: '', email: 'a@example.com' });
	const cookies = makeCookiesWithState('s');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
		502,
		'invalid response from Google — please retry'
	);
});

test('callback returns 502 when the sub claim is not a string', async () => {
	stubTokenAndUserinfo({ sub: 123, email: 'a@example.com' });
	const cookies = makeCookiesWithState('s');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
		502,
		'invalid response from Google — please retry'
	);
});

test('callback returns 502 when userinfo has no usable sub claim', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenAndUserinfo({ email: 'a@example.com' });
	const cookies = makeCookiesWithState('s');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
		502,
		'invalid response from Google — please retry'
	);
	expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
		'google userinfo returned no usable sub claim'
	);
});

test.each([
	{ name: 'missing', userinfo: { sub: 'sub-1', name: 'One' } },
	{ name: 'empty', userinfo: { sub: 'sub-1', email: '', name: 'One' } },
	{ name: 'non-string', userinfo: { sub: 'sub-1', email: 123, name: 'One' } }
])(
	'callback synthesizes a placeholder email when Google sends no usable one ($name)',
	async ({ userinfo }) => {
		stubTokenAndUserinfo(userinfo);
		const cookies = makeCookiesWithState('s');
		await expectHttpError(
			loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
			302
		);
		expect(readPendingConsent(cookies as never, 's')).toEqual({
			kind: 'new',
			sub: 'sub-1',
			email: 'sub-1@accounts.google.com',
			displayName: 'One'
		});
	}
);

test.each([
	{ name: 'missing', userinfo: { sub: 'sub-1', email: 'one@example.com' } },
	{ name: 'empty', userinfo: { sub: 'sub-1', email: 'one@example.com', name: '' } },
	{ name: 'non-string', userinfo: { sub: 'sub-1', email: 'one@example.com', name: 42 } }
])(
	'callback falls back to the email as display name when Google sends no usable name ($name)',
	async ({ userinfo }) => {
		stubTokenAndUserinfo(userinfo);
		const cookies = makeCookiesWithState('s');
		await expectHttpError(
			loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
			302
		);
		expect(readPendingConsent(cookies as never, 's')).toEqual({
			kind: 'new',
			sub: 'sub-1',
			email: 'one@example.com',
			displayName: 'one@example.com'
		});
	}
);

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
	const userId = await seedConsentedUser('sub-1', 'v0.9');
	const { cookies, location } = await signIn();

	expect(location).toBe('/consent?state=s');
	expect(await sessionRows()).toHaveLength(0);
	// The re-acceptance flow is keyed to this account, not a fresh signup.
	expect(readPendingConsent(cookies as never, 's')).toEqual({ kind: 'existing', userId });
});

// The callback consumes exactly the state it validated; a second tab's pending
// state must survive every success path (new signup, re-consent, session).
test('a new-identity sign-in consumes only its own state, leaving other tabs valid', async () => {
	stubTokenAndUserinfo({ sub: 'sub-1', email: 'one@example.com', name: 'One' });
	const cookies = makeCookiesWithState('other-tab', 's');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
		302
	);
	expect(JSON.parse(cookies.get('oauth_state') ?? 'null')).toEqual(['other-tab']);
});

test('a stale-consent sign-in consumes only its own state, leaving other tabs valid', async () => {
	await seedConsentedUser('sub-1', 'v0.9');
	stubTokenAndUserinfo({ sub: 'sub-1', email: 'one@example.com', name: 'One' });
	const cookies = makeCookiesWithState('other-tab', 's');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
		302
	);
	expect(JSON.parse(cookies.get('oauth_state') ?? 'null')).toEqual(['other-tab']);
});

test('a successful sign-in consumes only its own state, leaving other tabs valid', async () => {
	await seedConsentedUser('sub-1');
	stubTokenAndUserinfo({ sub: 'sub-1', email: 'one@example.com', name: 'One' });
	const cookies = makeCookiesWithState('other-tab', 's');
	await expectHttpError(
		loginCallback({ url: callbackUrl({ state: 's', code: 'x' }), cookies } as never),
		302
	);
	expect(JSON.parse(cookies.get('oauth_state') ?? 'null')).toEqual(['other-tab']);
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
