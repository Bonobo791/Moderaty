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
import { readPendingChannelPick } from '$lib/server/channelConnect';
import { channels } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/session';
import { GET as authCallback } from './+server';

setupTestDb(['channels']);

const OWNER = TEST_OWNER;

afterEach(() => {
	vi.unstubAllGlobals();
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

async function captureCallback(user: SessionUser | null = OWNER, cookies = makeCookiesWithState('s')) {
	try {
		await authCallback({
			url: new URL('http://localhost:5173/api/auth/google/callback?code=abc&state=s'),
			cookies,
			locals: { user }
		} as never);
		return { thrown: undefined, cookies };
	} catch (e) {
		return { thrown: e as { status: number; location?: string }, cookies };
	}
}

test('a member cannot connect a channel — 403 before any Google call or write', async () => {
	const member: SessionUser = { ...OWNER, orgRole: 'member' };

	const { thrown } = await captureCallback(member);

	expect(thrown).toMatchObject({ status: 403 });
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
});

test('a new channel is inserted and attached to the caller', async () => {
	stubTokenAndChannel();

	const { thrown } = await captureCallback();

	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC123', userId: OWNER.id, orgId: 'org-1', title: 'My Channel' });
	expect(row?.refreshTokenEnc).not.toBe('refresh-token');
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

	const { thrown } = await captureCallback(OWNER, cookies);

	expect(thrown).toMatchObject({ status: 302, location: '/connect-channel?state=s' });
	// Nothing is connected — the refresh token must not be persisted until a
	// channel is chosen.
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
	const parked = readPendingChannelPick(cookies as never, 's');
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

	const { thrown } = await captureCallback(OWNER, cookies);

	expect(seenPageTokens).toEqual([null, 'p2']);
	expect(thrown).toMatchObject({ status: 302, location: '/connect-channel?state=s' });
	expect(readPendingChannelPick(cookies as never, 's')?.channels).toHaveLength(2);
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
	expect(readPendingChannelPick(cookies as never, 's')).toBeNull();
	errSpy.mockRestore();
});
