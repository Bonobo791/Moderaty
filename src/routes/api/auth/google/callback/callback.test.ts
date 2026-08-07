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

// Real-database coverage for the conditional-upsert ownership predicate —
// the mocked suite in ../oauth.test.ts can only assert that a setWhere was
// passed, not that it actually blocks a foreign owner.

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

import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { makeCookiesWithState } from '$lib/server/testcookies';
import { parkChannelState, readPendingChannelPick } from '$lib/server/channelConnect';
import { channels } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/session';
import { GET as authCallback } from './+server';

setupTestDb(['channels']);

const OWNER = TEST_OWNER;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function stubTokenAndChannel() {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') {
				return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'refresh-token' }), { status: 200 });
			}
			if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
				return new Response(JSON.stringify({ items: [{ id: 'UC123', snippet: { title: 'My Channel' } }] }), {
					status: 200
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		})
	);
}

/** Stubs the token exchange plus a custom channels-list response handler. */
function stubTokenAndChannels(listChannels: (url: URL) => Response) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') {
				return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'refresh-token' }), { status: 200 });
			}
			if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
				return listChannels(new URL(url));
			}
			throw new Error(`unexpected fetch: ${url}`);
		})
	);
}

/** Simulates the channel-connect start: the shared state AND its user binding. */
function withChannelState(cookies: ReturnType<typeof makeCookiesWithState>, userId: string) {
	parkChannelState(cookies as never, 's', userId);
	return cookies;
}

async function captureCallback(
	user: SessionUser | null = OWNER,
	cookies: ReturnType<typeof makeCookiesWithState> = withChannelState(makeCookiesWithState('s'), OWNER.id)
) {
	try {
		await authCallback({
			url: new URL('http://localhost:5173/api/auth/google/callback?code=abc&state=s'),
			cookies,
			locals: { user }
		} as never);
		return { thrown: undefined, cookies };
	} catch (e) {
		return { thrown: e as { status: number; location?: string; body?: { message: string } }, cookies };
	}
}

async function captureCallbackWithUrl(
	url: URL,
	cookies: ReturnType<typeof makeCookiesWithState> = withChannelState(makeCookiesWithState('s'), OWNER.id)
) {
	try {
		await authCallback({ url, cookies, locals: { user: OWNER } } as never);
		return { thrown: undefined as undefined | { status: number; location?: string; body?: { message: string } }, cookies };
	} catch (e) {
		return { thrown: e as { status: number; location?: string; body?: { message: string } }, cookies };
	}
}

test('a member cannot connect a channel — 403 before any Google call or write', async () => {
	const member: SessionUser = { ...OWNER, orgRole: 'member' };

	const { thrown } = await captureCallback(member);

	expect(thrown).toMatchObject({ status: 403 });
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
});

test('rejects a state started by a DIFFERENT user — the code is never exchanged (CodeRabbit 3738037981)', async () => {
	stubTokenAndChannel();
	// A's flow (state bound to user-a), but B (OWNER) is the signed-in user when
	// the callback lands — a shared-browser completion attempt. The callback
	// must reject BEFORE exchanging the code, so A's grant can never be parked
	// (or connected) under B.
	const cookies = makeCookiesWithState('s');
	parkChannelState(cookies as never, 's', 'user-a');

	const { thrown } = await captureCallback(OWNER, cookies);

	expect(thrown).toMatchObject({ status: 400 });
	expect(thrown?.body?.message).toContain('different account');
	// The authorization code was never exchanged — no Google call happened.
	expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	// Nothing was parked or written under B.
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
	expect(readPendingChannelPick(cookies as never, 's', OWNER.id)).toBeNull();
});

test('a new channel is inserted and attached to the caller', async () => {
	stubTokenAndChannel();

	const { thrown } = await captureCallback();

	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC123', userId: OWNER.id, orgId: 'org-1', title: 'My Channel' });
	expect(row?.refreshTokenEnc).not.toBe('refresh-token');
	// The scan window starts at connection time: comments published BEFORE the
	// channel was connected are never moderated.
	expect(row?.cursor).toBeTruthy();
	expect(row?.cursor).toBe(row?.createdAt);
});

test('a channel already owned by the caller is updated', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC123', userId: OWNER.id, orgId: 'org-1', title: 'Old title', refreshTokenEnc: 'old-enc', active: 0 });
	stubTokenAndChannel();

	const { thrown } = await captureCallback();

	expect(thrown).toMatchObject({ status: 302 });
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC123', userId: OWNER.id, orgId: 'org-1', title: 'My Channel', active: 1 });
	expect(row?.refreshTokenEnc).not.toBe('old-enc');
});

test('a channel owned by a teammate is updated — the token-handover path', async () => {
	// Same org, different connector: the re-connect hands the token over to
	// the caller while the channel stays in the team.
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC123', userId: 'user-2', orgId: 'org-1', title: 'Old title', refreshTokenEnc: 'old-enc', active: 0 });
	stubTokenAndChannel();

	const { thrown } = await captureCallback();

	expect(thrown).toMatchObject({ status: 302 });
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC123', userId: OWNER.id, orgId: 'org-1', title: 'My Channel', active: 1 });
	expect(row?.refreshTokenEnc).not.toBe('old-enc');
});

test('a channel owned by another team stays unchanged and yields 409', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC123', userId: 'user-2', orgId: 'org-2', title: 'Not yours', refreshTokenEnc: 'foreign-enc' });
	stubTokenAndChannel();

	const { thrown } = await captureCallback();

	expect(thrown?.status).toBe(409);
	expect(thrown?.body?.message).toBe('this channel is connected to a different Moderaty team');
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC123', userId: 'user-2', orgId: 'org-2', title: 'Not yours', refreshTokenEnc: 'foreign-enc' });
});

test('a multi-channel account parks the channels and redirects to the picker without writing anything', async () => {
	stubTokenAndChannels(
		() =>
			new Response(
				JSON.stringify({
					items: [
						{ id: 'UC1', snippet: { title: 'One' } },
						{ id: 'UC2', snippet: { title: 'Two' } }
					]
				}),
				{ status: 200 }
			)
	);
	const cookies = makeCookiesWithState('s');
	parkChannelState(cookies as never, 's', OWNER.id);

	const { thrown } = await captureCallback(OWNER, cookies);

	expect(thrown).toMatchObject({ status: 302, location: '/connect-channel?state=s' });
	// Nothing is connected — the refresh token must not be persisted until a
	// channel is chosen.
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
	const parked = readPendingChannelPick(cookies as never, 's', OWNER.id);
	expect(parked?.channels).toEqual([
		{ id: 'UC1', title: 'One' },
		{ id: 'UC2', title: 'Two' }
	]);
	expect(parked?.refreshToken).toBe('refresh-token');
});

test('the channel listing paginates and every valid channel reaches the picker', async () => {
	const seenPageTokens: (string | null)[] = [];
	stubTokenAndChannels((url) => {
		seenPageTokens.push(url.searchParams.get('pageToken'));
		if (!url.searchParams.get('pageToken')) {
			return new Response(
				JSON.stringify({ items: [{ id: 'UC1', snippet: { title: 'One' } }], nextPageToken: 'p2' }),
				{ status: 200 }
			);
		}
		return new Response(JSON.stringify({ items: [{ id: 'UC2', snippet: { title: 'Two' } }] }), { status: 200 });
	});
	const cookies = makeCookiesWithState('s');
	parkChannelState(cookies as never, 's', OWNER.id);

	const { thrown } = await captureCallback(OWNER, cookies);

	expect(seenPageTokens).toEqual([null, 'p2']);
	expect(thrown).toMatchObject({ status: 302, location: '/connect-channel?state=s' });
	expect(readPendingChannelPick(cookies as never, 's', OWNER.id)?.channels).toHaveLength(2);
});

test('a malformed channel item is skipped and the single valid channel short-circuits to the connect', async () => {
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenAndChannels(
		() =>
			new Response(
				JSON.stringify({
					items: [{ id: 42 }, { id: 'UC9', snippet: { title: 'Valid' } }]
				}),
				{ status: 200 }
			)
	);

	const { thrown, cookies } = await captureCallback();

	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC9', title: 'Valid' });
	// The skip is counted and loud, never silent (I1).
	expect(errSpy.mock.calls.flat().join(' ')).toMatch(/skipped 1 malformed/);
	// No picker was parked for the single-channel path.
	expect(readPendingChannelPick(cookies as never, 's', OWNER.id)).toBeNull();
	errSpy.mockRestore();
});

test('the token exchange uses this flow\'s redirect URI and the channels listing asks for the caller\'s channels', async () => {
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url === 'https://oauth2.googleapis.com/token') {
				return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'refresh-token' }), { status: 200 });
			}
			if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
				return new Response(JSON.stringify({ items: [{ id: 'UC123', snippet: { title: 'My Channel' } }] }), {
					status: 200
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		})
	);

	const { thrown } = await captureCallback();

	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });

	// The redirect URI must be THIS flow's callback — a wrong path breaks the
	// exchange against Google's registered-URI check.
	const tokenCall = calls.find((c) => c.url === 'https://oauth2.googleapis.com/token');
	const tokenBody = new URLSearchParams(String(tokenCall?.init?.body));
	expect(tokenBody.get('redirect_uri')).toBe('http://localhost:5173/api/auth/google/callback');

	// The listing must request the caller's own channels, 50 per page, snippet
	// part, authorized with the fresh access token.
	const channelCall = calls.find((c) => c.url.startsWith('https://www.googleapis.com/youtube/v3/channels'));
	expect(channelCall, 'channels listing request captured').toBeDefined();
	const channelUrl = new URL(channelCall!.url);
	expect(channelUrl.searchParams.get('part')).toBe('snippet');
	expect(channelUrl.searchParams.get('mine')).toBe('true');
	expect(channelUrl.searchParams.get('maxResults')).toBe('50');
	expect(channelUrl.searchParams.get('pageToken')).toBeNull();
	expect((channelCall!.init?.headers as Record<string, string>).Authorization).toBe('Bearer a');

	// Zero malformed items → zero skip logging.
	expect(errSpy.mock.calls.flat().join(' ')).not.toMatch(/skipped/);
});

test('a non-OK channels status fails loudly with the lookup-failed message', async () => {
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenAndChannels(() => new Response('quota exceeded', { status: 403 }));

	const { thrown } = await captureCallback();

	expect(thrown?.status).toBe(502);
	expect(thrown?.body?.message).toBe('YouTube channel lookup failed — please retry');
	expect(errSpy.mock.calls.flat().join(' ')).toMatch(/youtube channels lookup failed: 403/);
});

test('an invalid-JSON channels body fails loudly as an invalid YouTube response', async () => {
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenAndChannels(() => new Response('this is not json', { status: 200 }));

	const { thrown } = await captureCallback();

	expect(thrown?.status).toBe(502);
	expect(thrown?.body?.message).toBe('invalid response from YouTube — please retry');
	expect(errSpy.mock.calls.flat().join(' ')).toMatch(/youtube channels lookup returned invalid JSON: 200/);
});

test('a non-object channels body fails loudly as an invalid YouTube response', async () => {
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenAndChannels(() => new Response('null', { status: 200 }));

	const { thrown } = await captureCallback();

	expect(thrown?.status).toBe(502);
	expect(thrown?.body?.message).toBe('invalid response from YouTube — please retry');
	expect(errSpy.mock.calls.flat().join(' ')).toMatch(/youtube channels lookup returned a non-object body: 200/);
});

test('a channels body without an items array is an empty account — 400, nothing logged, nothing written', async () => {
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenAndChannels(() => new Response(JSON.stringify({}), { status: 200 }));

	const { thrown } = await captureCallback();

	expect(thrown?.status).toBe(400);
	expect(thrown?.body?.message).toBe('no YouTube channel found for this Google account');
	// A missing items array is NOT a malformed item — nothing is skipped.
	expect(errSpy).not.toHaveBeenCalled();
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
});

test('a channel without a snippet title is stored as Untitled channel', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenAndChannels(
		() => new Response(JSON.stringify({ items: [{ id: 'UC123' }] }), { status: 200 })
	);

	const { thrown } = await captureCallback();

	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC123', title: 'Untitled channel' });
});

test('a null channel item is skipped without crashing the walk', async () => {
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	stubTokenAndChannels(
		() =>
			new Response(JSON.stringify({ items: [null, { id: 'UC9', snippet: { title: 'Valid' } }] }), { status: 200 })
	);

	const { thrown } = await captureCallback();

	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC9', title: 'Valid' });
	expect(errSpy.mock.calls.flat().join(' ')).toMatch(/skipped 1 malformed/);
});

test('a non-string nextPageToken stops the listing walk instead of being followed', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	let channelFetches = 0;
	stubTokenAndChannels((url) => {
		channelFetches++;
		if (!url.searchParams.get('pageToken')) {
			// I2: a wrong-typed page token is invalid data — never followed.
			return new Response(
				JSON.stringify({ items: [{ id: 'UC1', snippet: { title: 'One' } }], nextPageToken: 123 }),
				{ status: 200 }
			);
		}
		return new Response(JSON.stringify({ items: [{ id: 'UC2', snippet: { title: 'Two' } }] }), { status: 200 });
	});

	const { thrown } = await captureCallback();

	expect(channelFetches).toBe(1);
	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC1', title: 'One' });
});

test('a pathological pageToken loop stops at the page bound and logs the truncation', async () => {
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	let channelFetches = 0;
	stubTokenAndChannels(() => {
		channelFetches++;
		return new Response(
			JSON.stringify({ items: [{ id: 'UC1', snippet: { title: 'One' } }], nextPageToken: 'more' }),
			{ status: 200 }
		);
	});
	const cookies = makeCookiesWithState('s');
	parkChannelState(cookies as never, 's', OWNER.id);

	const { thrown } = await captureCallback(OWNER, cookies);

	expect(channelFetches).toBe(10);
	expect(errSpy.mock.calls.flat().join(' ')).toMatch(/hit the 10-page bound/);
	expect(thrown).toMatchObject({ status: 302, location: '/connect-channel?state=s' });
	expect(readPendingChannelPick(cookies as never, 's', OWNER.id)?.channels).toHaveLength(10);
});

test('bad state and missing code reject with descriptive 400 messages', async () => {
	const cookies = makeCookiesWithState('s');
	parkChannelState(cookies as never, 's', OWNER.id);

	const missingState = await captureCallbackWithUrl(
		new URL('http://localhost:5173/api/auth/google/callback?code=abc'),
		cookies
	);
	expect(missingState.thrown?.status).toBe(400);
	expect(missingState.thrown?.body?.message).toBe('bad state');

	const forgedState = await captureCallbackWithUrl(
		new URL('http://localhost:5173/api/auth/google/callback?code=abc&state=forged'),
		cookies
	);
	expect(forgedState.thrown?.status).toBe(400);
	expect(forgedState.thrown?.body?.message).toBe('bad state');

	const missingCode = await captureCallbackWithUrl(
		new URL('http://localhost:5173/api/auth/google/callback?state=s'),
		cookies
	);
	expect(missingCode.thrown?.status).toBe(400);
	expect(missingCode.thrown?.body?.message).toBe('missing code');
});

test('a failed token exchange surfaces the flow-specific message and log prefix', async () => {
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'code was already redeemed' }), {
					status: 400
				})
		)
	);

	const { thrown } = await captureCallback();

	expect(thrown?.status).toBe(502);
	expect(thrown?.body?.message).toBe('Google token exchange failed — please retry');
	expect(errSpy.mock.calls.flat().join(' ')).toMatch(/google token exchange failed: 400 invalid_grant: code was already redeemed/);
});

test('a token exchange without a refresh token rejects before any channels lookup', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	let channelFetches = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') {
				// Re-consent case: Google answers 200 without a refresh_token.
				return new Response(JSON.stringify({ access_token: 'a' }), { status: 200 });
			}
			if (url.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
				channelFetches++;
				return new Response(JSON.stringify({ items: [{ id: 'UC1', snippet: { title: 'One' } }] }), {
					status: 200
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		})
	);

	const { thrown } = await captureCallback();

	expect(thrown?.status).toBe(400);
	expect(thrown?.body?.message).toMatch(/^token exchange returned no refresh_token/);
	// The flow must stop here — no lookup, no write with a missing token.
	expect(channelFetches).toBe(0);
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
});

test('a primitive (string) channels body fails loudly as an invalid YouTube response', async () => {
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	// Valid JSON, but a string — not an object with items. I2: wrong-typed
	// external data means the API call failed, never an empty channel list.
	stubTokenAndChannels(() => new Response(JSON.stringify('just a string'), { status: 200 }));

	const { thrown } = await captureCallback();

	expect(thrown?.status).toBe(502);
	expect(thrown?.body?.message).toBe('invalid response from YouTube — please retry');
	expect(errSpy.mock.calls.flat().join(' ')).toMatch(/youtube channels lookup returned a non-object body: 200/);
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
});
