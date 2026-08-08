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

import { expect, test, vi } from 'vitest';

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
import { makeCookies } from '$lib/server/testcookies';
import { parkPendingChannelPick, readPendingChannelPick } from '$lib/server/channelConnect';
import { channels } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/session';
import { actions, load } from './+page.server';

setupTestDb(['channels']);

const OWNER: SessionUser = TEST_OWNER;
const PICK = {
	refreshToken: 'refresh-token',
	channels: [
		{ id: 'UC1', title: 'One' },
		{ id: 'UC2', title: 'Two' }
	]
};

function cookiesWithPick(state = 's', userId = OWNER.id) {
	const cookies = makeCookies();
	parkPendingChannelPick(cookies as never, state, PICK, userId);
	return cookies;
}

function loadWith(cookies: ReturnType<typeof makeCookies>, state: string | null = 's', user: SessionUser | null = OWNER) {
	return load({
		cookies,
		url: new URL(`http://localhost/connect-channel${state ? `?state=${state}` : ''}`),
		locals: { user }
	} as never);
}

async function captureAction(cookies: ReturnType<typeof makeCookies>, channelId: string | null, state = 's', user: SessionUser | null = OWNER) {
	const form = new FormData();
	if (channelId !== null) form.set('channel', channelId);
	const request = new Request(`http://localhost/connect-channel?state=${state}`, { method: 'POST', body: form });
	try {
		const res = await actions.default({
			cookies,
			request,
			url: new URL(request.url),
			locals: { user }
		} as never);
		return res as { status: number; data?: { error?: string } };
	} catch (e) {
		return e as { status: number; location?: string };
	}
}

test('load without a state param fails loudly with 400', async () => {
	await expect(loadWith(cookiesWithPick(), null)).rejects.toMatchObject({
		status: 400,
		body: { message: 'missing state — restart the channel connection from the dashboard' }
	});
});

test('load without a parked pick fails loudly with 400', async () => {
	await expect(loadWith(makeCookies())).rejects.toMatchObject({
		status: 400,
		body: { message: 'this channel selection expired — reconnect the channel from the dashboard' }
	});
});

test('load rejects a team member — connecting channels is admin+ only', async () => {
	await expect(
		loadWith(cookiesWithPick(), 's', { ...OWNER, orgRole: 'member' })
	).rejects.toMatchObject({ status: 403 });
});

test('load returns the parked channels without ever exposing the refresh token', async () => {
	const data = (await loadWith(cookiesWithPick())) as { channels: unknown };

	expect(data.channels).toEqual(PICK.channels);
	expect(JSON.stringify(data)).not.toContain('refresh-token');
});

test('a signed-out picker POST is rejected before any write', async () => {
	const res = await captureAction(cookiesWithPick(), 'UC1', 's', null);
	expect(res).toMatchObject({ status: 401 });
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
});

test('a member cannot complete the picker — 403 before any write', async () => {
	const res = await captureAction(cookiesWithPick(), 'UC1', 's', { ...OWNER, orgRole: 'member' });
	expect(res).toMatchObject({ status: 403 });
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
});

test('choosing a parked channel connects it, encrypts the token, and consumes the state', async () => {
	const cookies = cookiesWithPick();

	const res = await captureAction(cookies, 'UC2');

	expect(res).toMatchObject({ status: 302, location: '/dashboard' });
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC2', userId: OWNER.id, orgId: OWNER.orgId, title: 'Two', active: 1 });
	expect(row?.refreshTokenEnc).not.toBe('refresh-token');
	// The parked pick for this flow is gone — no replay.
	expect(readPendingChannelPick(cookies as never, 's', OWNER.id)).toBeNull();
});

test('a channel id that was never parked fails loudly with 400 and writes nothing', async () => {
	const res = await captureAction(cookiesWithPick(), 'UC-FORGED');

	expect(res).toMatchObject({
		status: 400,
		data: { error: 'Unknown channel — pick one of the listed channels.' }
	});
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
});

test('a replayed state after a successful pick fails loudly with 400', async () => {
	const cookies = cookiesWithPick();
	await captureAction(cookies, 'UC1');

	const res = await captureAction(cookies, 'UC2');

	expect(res).toMatchObject({
		status: 400,
		data: { error: 'This channel selection expired — reconnect the channel from the dashboard.' }
	});
	expect(await testDb().db.select().from(channels).all()).toHaveLength(1);
});

test('a parked channel owned by another team yields 409 and stays unchanged', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC2', userId: 'user-2', orgId: 'org-2', title: 'Not yours', refreshTokenEnc: 'foreign-enc' });

	const res = await captureAction(cookiesWithPick(), 'UC2');

	expect(res).toMatchObject({
		status: 409,
		data: { error: 'This channel is connected to a different Moderaty team.' }
	});
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC2', userId: 'user-2', orgId: 'org-2', refreshTokenEnc: 'foreign-enc' });
});

test('a pick parked by another user reads as expired — no cross-user completion (shared browser)', async () => {
	// Hardening: user B, signed in on a shared machine with user A's pick URL,
	// must not complete A's pick — the parked refresh token would be attached
	// to B's org. Both the load and the action must reject.
	const other: SessionUser = { ...OWNER, id: 'user-b', email: 'b@example.com' };
	const cookies = cookiesWithPick('s', OWNER.id); // parked by A

	await expect(loadWith(cookies, 's', other)).rejects.toMatchObject({
		status: 400,
		body: { message: 'this channel selection expired — reconnect the channel from the dashboard' }
	});
	const res = await captureAction(cookies, 'UC1', 's', other);
	expect(res).toMatchObject({
		status: 400,
		data: { error: 'This channel selection expired — reconnect the channel from the dashboard.' }
	});
	// Nothing was connected and the parked pick is still readable by its owner.
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
	expect(readPendingChannelPick(cookies as never, 's', OWNER.id)).toEqual(PICK);
});
