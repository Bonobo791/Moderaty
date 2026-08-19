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

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {
		GOOGLE_CLIENT_ID: 'client-id',
		GOOGLE_CLIENT_SECRET: 'client-secret',
		APP_URL: 'http://localhost:5173',
		ENCRYPTION_KEY: 'test-encryption-key'
	} as Record<string, string | undefined>,
	upserts: [] as Record<string, unknown>[],
	existingChannel: undefined as { orgId: string | null } | undefined
}));

const OWNER = TEST_OWNER;

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

vi.mock('$lib/server/db', () => ({
	db: {
		insert: () => ({
			values: (values: unknown) => ({
				onConflictDoUpdate: ({ set, setWhere }: { set: unknown; setWhere: unknown }) => ({
					returning: async () => {
						mocks.upserts.push({ values, set, setWhere });
						// The mock can't evaluate the setWhere predicate; simulate the
						// "owned by another team" case as a skipped (empty) update.
						// 'org-1' matches OWNER.orgId below.
						if (mocks.existingChannel?.orgId && mocks.existingChannel.orgId !== 'org-1') return [];
						return [{ id: 'UC123' }];
					}
				})
			})
		})
	}
}));

import { makeCookies, makeCookiesWithState } from '$lib/server/testcookies';
import { TEST_OWNER } from '$lib/server/testuser';
import { createChannelState, decodeChannelState } from '$lib/server/channelConnect';
import { GET as startAuth } from './+server';
import { GET as authCallback } from './callback/+server';

function callbackUrl(params: Record<string, string>) {
	const search = new URLSearchParams(params);
	return new URL(`http://localhost:5173/api/auth/google/callback?${search}`);
}

function stubTokenAndChannelResponses(channelResponse?: Response) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') {
				return new Response(
					JSON.stringify({ access_token: 'super-secret-access-token', refresh_token: 'refresh-token' }),
					{ status: 200 }
				);
			}
			if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
				return (
					channelResponse ??
					new Response(JSON.stringify({ items: [{ id: 'UC123', snippet: { title: 'My Channel' } }] }), {
						status: 200
					})
				);
			}
			throw new Error(`unexpected fetch: ${url}`);
		})
	);
}

beforeEach(() => {
	mocks.env.GOOGLE_CLIENT_ID = 'client-id';
	mocks.env.GOOGLE_CLIENT_SECRET = 'client-secret';
	mocks.env.APP_URL = 'http://localhost:5173';
	mocks.env.ENCRYPTION_KEY = 'test-encryption-key';
	mocks.upserts.length = 0;
	mocks.existingChannel = undefined;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

type Cookies = ReturnType<typeof makeCookies>;

function captureStartAuth(cookies: Cookies): { status: number; location: string } | undefined {
	try {
		startAuth({ cookies, locals: { user: OWNER } } as never);
		return undefined;
	} catch (e) {
		return e as { status: number; location: string };
	}
}

async function captureCallback(
	cookies: Cookies,
	params: Record<string, string>,
	user: typeof OWNER | null = OWNER
): Promise<{ status: number; location?: string; body?: { message: string } } | undefined> {
	try {
		// Simulate the channel-connect start for the flow. A signed-in start
		// issues a SELF-AUTHENTICATING state (the starter rides inside the
		// ciphertext), so tests that don't pin a specific state get a real one;
		// tests that pass an explicit state (bad-state coverage) keep it
		// verbatim. The callback accepts a state that decodes for this user
		// even when its cookie entry is absent.
		const state = params.state ?? (user ? createChannelState(user.id) : 's');
		await authCallback({ url: callbackUrl({ ...params, state }), cookies, locals: { user } } as never);
		return undefined;
	} catch (e) {
		return e as { status: number; location?: string; body?: { message: string } };
	}
}

async function expectCallbackThrows(status: number) {
	const thrown = await captureCallback(makeCookiesWithState(), { code: 'abc' });
	expect(thrown?.status).toBe(status);
	return thrown;
}

function assertNoTokenLeak(
	thrown: { status: number; body?: { message: string } } | undefined,
	errorSpy: { mock: { calls: unknown[][] } }
) {
	expect(thrown?.body?.message ?? '').not.toContain('super-secret-access-token');
	for (const call of errorSpy.mock.calls) {
		expect(call.join(' ')).not.toContain('super-secret-access-token');
	}
}

test('auth start sets an HttpOnly oauth_state cookie and redirects with matching state', () => {
	const cookies = makeCookies();
	const thrown = captureStartAuth(cookies);
	expect(thrown?.status).toBe(302);

	const stateCall = cookies.setCalls.find((c) => c.name === 'oauth_state');
	expect(stateCall, 'oauth_state cookie must be set').toBeDefined();
	expect(stateCall?.opts.httpOnly).toBe(true);

	const target = new URL(thrown?.location ?? '');

	// A signed-in connect issues a SELF-AUTHENTICATING state: the starter's
	// userId rides inside the AES-256-GCM ciphertext, so the callback derives
	// it from the state itself — unforgeable (no ENCRYPTION_KEY) and immune to
	// the shared-cookie read-modify-write race.
	const redirectState = target.searchParams.get('state');
	expect(redirectState).toBeTruthy();
	expect(decodeChannelState(redirectState ?? '')).toEqual({ userId: OWNER.id });

	const pendingStates: unknown = JSON.parse(stateCall?.value ?? '[]');
	expect(target.origin + target.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
	expect(pendingStates).toContain(redirectState);
	expect(target.searchParams.get('client_id')).toBe('client-id');
	expect(target.searchParams.get('response_type')).toBe('code');
	expect(target.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.force-ssl');
	expect(target.searchParams.get('access_type')).toBe('offline');
	expect(target.searchParams.get('prompt')).toBe('consent select_account');
	expect(target.searchParams.get('redirect_uri')).toBe(
		'http://localhost:5173/api/auth/google/callback'
	);
});

test('auth start fails loudly with 500 when GOOGLE_CLIENT_ID is not configured', () => {
	mocks.env.GOOGLE_CLIENT_ID = undefined;
	expect(() => startAuth({ cookies: makeCookies() } as never)).toThrowError(
		expect.objectContaining({
			status: 500,
			body: { message: 'GOOGLE_CLIENT_ID is not configured' }
		})
	);
});

test('auth start fails loudly with 500 when APP_URL is not configured', () => {
	mocks.env.APP_URL = undefined;
	expect(() => startAuth({ cookies: makeCookies() } as never)).toThrowError(
		expect.objectContaining({
			status: 500,
			body: { message: 'APP_URL is not configured' }
		})
	);
});

test('callback rejects a missing or mismatched state with 400', async () => {
	const state = createChannelState(OWNER.id);
	const cookies = makeCookiesWithState(state);
	// Missing state param — the URL is used verbatim (no auto-created state).
	const missing = await authCallback({
		url: callbackUrl({ code: 'abc' }),
		cookies,
		locals: { user: OWNER }
	} as never).catch((e: { status: number }) => e);
	expect(missing?.status).toBe(400);
	// A mismatched/forged state is neither in the cookie nor decodable.
	expect((await captureCallback(cookies, { code: 'abc', state: 'forged' }))?.status).toBe(400);
});

test('callback rejects a missing code with 400', async () => {
	const state = createChannelState(OWNER.id);
	const cookies = makeCookiesWithState(state);
	expect((await captureCallback(cookies, { state }))?.status).toBe(400);
});

test.each([
	{
		name: 'missing refresh_token',
		status: 200,
		// Google answers 200 but without a refresh_token (re-consent case).
		body: { access_token: 'super-secret-access-token' },
		expectedStatus: 400,
		logged: false
	},
	{
		name: 'failed token exchange',
		status: 400,
		// Must not surface as a 400 "revoke access" message, and even a
		// hypothetical token in the error body must stay out of logs.
		body: {
			error: 'invalid_grant',
			error_description: 'Code was already redeemed',
			access_token: 'super-secret-access-token'
		},
		expectedStatus: 502,
		logged: true
	}
])(
	'callback errors never leak tokens to client or logs ($name)',
	async ({ status, body, expectedStatus, logged }) => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

		const thrown = await captureCallback(makeCookiesWithState(), { code: 'abc' });
		expect(thrown?.status).toBe(expectedStatus);
		expect(errorSpy.mock.calls.length > 0).toBe(logged);
		assertNoTokenLeak(thrown, errorSpy);
	}
);

test('callback fails loudly when the channels lookup returns a non-OK status', async () => {
	// 403 is non-retryable, so fetchWithRetry returns it immediately.
	stubTokenAndChannelResponses(new Response('quota exceeded', { status: 403 }));

	await expectCallbackThrows(502);
});

test('callback upserts the channel and redirects home on the happy path', async () => {
	stubTokenAndChannelResponses();

	const thrown = await captureCallback(makeCookiesWithState(), { code: 'abc' });
	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });

	expect(mocks.upserts).toHaveLength(1);
	const values = mocks.upserts[0].values as Record<string, unknown>;
	expect(values.id).toBe('UC123');
	expect(values.title).toBe('My Channel');
	expect(values.refreshTokenEnc).not.toBe('refresh-token');
});

test('overlapping OAuth starts in two tabs both stay valid', async () => {
	stubTokenAndChannelResponses();
	const cookies = makeCookies();

	// Two tabs each start the flow before either callback returns.
	const states: string[] = [];
	for (let i = 0; i < 2; i++) {
		const thrown = captureStartAuth(cookies);
		states.push(new URL(thrown?.location ?? '').searchParams.get('state') ?? '');
	}
	expect(states[0]).not.toBe(states[1]);

	// Tab 1's callback must succeed even though tab 2's start wrote the cookie
	// after it — and vice versa. The self-authenticating states are valid even
	// if a concurrent write dropped a cookie entry (the signature is the
	// authority), and each upsert is idempotent.
	for (const state of states) {
		const thrown = await captureCallback(cookies, { code: 'abc', state });
		expect(thrown?.status).toBe(302);
	}
	expect(mocks.upserts).toHaveLength(2);

	// The state is not single-use by itself: it stays a valid 10-minute
	// capability after consumption, and OUR gate still passes it. Replay
	// protection for the authorization CODE lives at Google (single-use,
	// client+redirect-bound): a replayed callback URL fails at the exchange —
	// modeled here by the token endpoint rejecting the already-spent code.
	vi.unstubAllGlobals();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === 'https://oauth2.googleapis.com/token') {
				return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
			}
			throw new Error(`unexpected fetch: ${String(input)}`);
		})
	);
	const replay = await captureCallback(cookies, { code: 'abc', state: states[0] });
	expect(replay?.status).toBe(502);
	// No third upsert — the spent code never produced a grant.
	expect(mocks.upserts).toHaveLength(2);
});

test('callback returns 502 when the token request itself fails', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new Error('socket hang up');
		})
	);

	await expectCallbackThrows(502);
	expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
});

test('callback returns 502 when the token response is valid JSON but not an object', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })));

	await expectCallbackThrows(502);
});

test('callback returns 502 when the channels response is valid JSON but not an object', async () => {
	stubTokenAndChannelResponses(new Response('null', { status: 200 }));

	await expectCallbackThrows(502);
});

test('state survives a failed token exchange so the callback can be retried', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const cookies = makeCookiesWithState();
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 }))
	);

	const first = await captureCallback(cookies, { code: 'abc' });
	expect(first?.status).toBe(502);

	stubTokenAndChannelResponses();
	const second = await captureCallback(cookies, { code: 'abc' });
	expect(second).toMatchObject({ status: 302, location: '/dashboard' });
	expect(mocks.upserts).toHaveLength(1);
});

test('youtube lookup failure logs do not include the upstream response body', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenAndChannelResponses(new Response('quota exceeded', { status: 403 }));

	await expectCallbackThrows(502);
	expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
	for (const call of errorSpy.mock.calls) {
		expect(call.join(' ')).not.toContain('quota exceeded');
	}
});

test('callback rejects a signed-out request with 401', async () => {
	stubTokenAndChannelResponses();

	const thrown = await captureCallback(makeCookiesWithState(), { code: 'abc' }, null);

	expect(thrown?.status).toBe(401);
	expect(mocks.upserts).toHaveLength(0);
});

test('callback attaches the connected channel to the signed-in user', async () => {
	stubTokenAndChannelResponses();

	const thrown = await captureCallback(makeCookiesWithState(), { code: 'abc' });

	expect(thrown).toMatchObject({ status: 302 });
	expect(mocks.upserts).toHaveLength(1);
	expect((mocks.upserts[0].values as Record<string, unknown>).userId).toBe(OWNER.id);
});

test('callback refuses to reconnect a channel owned by another account with 409', async () => {
	mocks.existingChannel = { orgId: 'org-2' };
	stubTokenAndChannelResponses();

	const thrown = await captureCallback(makeCookiesWithState(), { code: 'abc' });

	expect(thrown?.status).toBe(409);
	// The write is attempted — the conditional upsert predicate is what blocks
	// it (simulated as an empty returning set), keeping the check atomic.
	expect(mocks.upserts).toHaveLength(1);
	expect(mocks.upserts[0].setWhere).toBeDefined();
});
