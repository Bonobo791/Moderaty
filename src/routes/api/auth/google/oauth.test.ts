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

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {
		GOOGLE_CLIENT_ID: 'client-id',
		GOOGLE_CLIENT_SECRET: 'client-secret',
		APP_URL: 'http://localhost:5173',
		ENCRYPTION_KEY: 'test-encryption-key'
	} as Record<string, string | undefined>,
	upserts: [] as Record<string, unknown>[]
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

vi.mock('$lib/server/db', () => ({
	db: {
		insert: () => ({
			values: (values: unknown) => ({
				onConflictDoUpdate: async ({ set }: { set: unknown }) => {
					mocks.upserts.push({ values, set });
				}
			})
		})
	}
}));

import { GET as startAuth } from './+server';
import { GET as authCallback } from './callback/+server';

function makeCookies() {
	const store = new Map<string, string>();
	const setCalls: Array<{ name: string; value: string; opts: Record<string, unknown> }> = [];
	return {
		setCalls,
		get: (name: string) => store.get(name),
		set: (name: string, value: string, opts: Record<string, unknown>) => {
			setCalls.push({ name, value, opts });
			store.set(name, value);
		},
		delete: (name: string) => {
			store.delete(name);
		}
	};
}

function callbackUrl(params: Record<string, string>) {
	const search = new URLSearchParams(params);
	return new URL(`http://localhost:5173/api/auth/google/callback?${search}`);
}

function stubTokenAndChannelResponses() {
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
				return new Response(
					JSON.stringify({ items: [{ id: 'UC123', snippet: { title: 'My Channel' } }] }),
					{ status: 200 }
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
});

afterEach(() => vi.unstubAllGlobals());

test('auth start sets an HttpOnly oauth_state cookie and redirects with matching state', () => {
	const cookies = makeCookies();
	let thrown: { status: number; location: string } | undefined;
	try {
		startAuth({ cookies } as never);
	} catch (e) {
		thrown = e as { status: number; location: string };
	}
	expect(thrown?.status).toBe(302);

	const stateCall = cookies.setCalls.find((c) => c.name === 'oauth_state');
	expect(stateCall, 'oauth_state cookie must be set').toBeDefined();
	expect(stateCall?.opts.httpOnly).toBe(true);

	const target = new URL(thrown?.location ?? '');
	expect(target.origin + target.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
	expect(target.searchParams.get('state')).toBe(stateCall?.value);
	expect(target.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.force-ssl');
	expect(target.searchParams.get('access_type')).toBe('offline');
	expect(target.searchParams.get('prompt')).toBe('consent');
	expect(target.searchParams.get('redirect_uri')).toBe(
		'http://localhost:5173/api/auth/google/callback'
	);
});

test('auth start fails loudly with 500 when GOOGLE_CLIENT_ID is not configured', () => {
	mocks.env.GOOGLE_CLIENT_ID = undefined;
	expect(() => startAuth({ cookies: makeCookies() } as never)).toThrowError(
		expect.objectContaining({ status: 500 })
	);
});

test('callback rejects a missing or mismatched state with 400', async () => {
	const cookies = makeCookies();
	cookies.set('oauth_state', 'the-real-state', { path: '/' });

	await expect(
		authCallback({ url: callbackUrl({ code: 'abc' }), cookies } as never)
	).rejects.toMatchObject({ status: 400 });

	await expect(
		authCallback({ url: callbackUrl({ code: 'abc', state: 'forged' }), cookies } as never)
	).rejects.toMatchObject({ status: 400 });
});

test('callback rejects a missing code with 400', async () => {
	const cookies = makeCookies();
	cookies.set('oauth_state', 's', { path: '/' });
	await expect(
		authCallback({ url: callbackUrl({ state: 's' }), cookies } as never)
	).rejects.toMatchObject({ status: 400 });
});

test('callback error for missing refresh_token never leaks the access token', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			// Google answers 200 but without a refresh_token (re-consent case).
			new Response(JSON.stringify({ access_token: 'super-secret-access-token' }), { status: 200 })
		)
	);
	const cookies = makeCookies();
	cookies.set('oauth_state', 's', { path: '/' });

	let thrown: { status: number; body?: { message: string } } | undefined;
	try {
		await authCallback({ url: callbackUrl({ code: 'abc', state: 's' }), cookies } as never);
	} catch (e) {
		thrown = e as { status: number; body?: { message: string } };
	}
	expect(thrown?.status).toBe(400);
	expect(thrown?.body?.message ?? '').not.toContain('super-secret-access-token');
});

test('callback fails loudly when the channels lookup returns a non-OK status', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') {
				return new Response(
					JSON.stringify({ access_token: 'tok', refresh_token: 'refresh-token' }),
					{ status: 200 }
				);
			}
			// 403 is non-retryable, so fetchWithRetry returns it immediately.
			return new Response('quota exceeded', { status: 403 });
		})
	);
	const cookies = makeCookies();
	cookies.set('oauth_state', 's', { path: '/' });

	await expect(
		authCallback({ url: callbackUrl({ code: 'abc', state: 's' }), cookies } as never)
	).rejects.toMatchObject({ status: 502 });
});

test('callback upserts the channel and redirects home on the happy path', async () => {
	stubTokenAndChannelResponses();
	const cookies = makeCookies();
	cookies.set('oauth_state', 's', { path: '/' });

	let thrown: { status: number; location: string } | undefined;
	try {
		await authCallback({ url: callbackUrl({ code: 'abc', state: 's' }), cookies } as never);
	} catch (e) {
		thrown = e as { status: number; location: string };
	}
	expect(thrown).toMatchObject({ status: 302, location: '/' });

	expect(mocks.upserts).toHaveLength(1);
	const values = mocks.upserts[0].values as Record<string, unknown>;
	expect(values.id).toBe('UC123');
	expect(values.title).toBe('My Channel');
	expect(values.refreshTokenEnc).not.toBe('refresh-token');
});
