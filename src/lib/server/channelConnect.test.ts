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

// Behavior tests for the parked channel-pick cookie (encrypted, state-keyed,
// 10-minute TTL, bounded) and the conditional channel upsert. The route-level
// suites (callback, connect-channel) exercise the happy paths; these tests pin
// the validation, expiry, and ownership-guard behavior directly.

import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {
		APP_URL: 'http://localhost:5173',
		ENCRYPTION_KEY: 'test-encryption-key'
	} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { makeCookies } from '$lib/server/testcookies';
import { decrypt, encrypt } from '$lib/server/crypto';
import {
	CHANNEL_PICK_COOKIE,
	clearPendingChannelPick,
	createChannelState,
	decodeChannelState,
	parkPendingChannelPick,
	readPendingChannelPick,
	upsertChannelConnection
} from '$lib/server/channelConnect';
import { channels } from '$lib/server/db/schema';

setupTestDb(['channels']);

const OWNER = TEST_OWNER;
const TTL_MS = 10 * 60 * 1000;

type Jar = ReturnType<typeof makeCookies>;

afterEach(() => {
	vi.useRealTimers();
});

/** Decrypts the raw pick cookie the way readEntries does. */
function parkedEntries(cookies: Jar): Array<{ state: string; ts: number; refreshToken: string }> {
	const raw = cookies.get(CHANNEL_PICK_COOKIE);
	expect(raw).toBeTruthy();
	return JSON.parse(decrypt(raw as string));
}

/** A jar whose pick cookie was forged (valid encryption, arbitrary payload). */
function forgedCookies(payload: unknown): Jar {
	const cookies = makeCookies();
	cookies.set(CHANNEL_PICK_COOKIE, encrypt(JSON.stringify(payload)), { path: '/' });
	return cookies;
}

function forgedEntry(overrides: Record<string, unknown> = {}) {
	return {
		state: 's',
		ts: Date.now(),
		// Baseline matches the parker's binding so the forged tests below
		// exercise their TARGETED field validation instead of failing at the
		// ownership check (CodeRabbit 3738037958).
		userId: 'user-1',
		refreshToken: 'refresh-token',
		channels: [{ id: 'UC1', title: 'One' }],
		...overrides
	};
}

// --- readPendingChannelPick ------------------------------------------------

test('read returns null when no pick cookie exists', () => {
	expect(readPendingChannelPick(makeCookies() as never, 's', 'user-1')).toBeNull();
});

test('read returns null for an unknown state', () => {
	const cookies = makeCookies();
	parkPendingChannelPick(cookies as never, 'other', { refreshToken: 'tok', channels: [{ id: 'UC1', title: 'One' }] }, 'user-1');

	expect(readPendingChannelPick(cookies as never, 's', 'user-1')).toBeNull();
});

test('read returns null for a tampered cookie', () => {
	const cookies = makeCookies();
	cookies.set(CHANNEL_PICK_COOKIE, 'not-valid-ciphertext', { path: '/' });

	expect(readPendingChannelPick(cookies as never, 's', 'user-1')).toBeNull();
});

test('read returns null when the decrypted payload is not an array', () => {
	const cookies = forgedCookies('just-a-string');

	expect(readPendingChannelPick(cookies as never, 's', 'user-1')).toBeNull();
});

test('read returns the grant parked for the matching state only', () => {
	const cookies = makeCookies();
	parkPendingChannelPick(cookies as never, 'a', { refreshToken: 'token-a', channels: [{ id: 'UC1', title: 'One' }] }, 'user-1');
	parkPendingChannelPick(cookies as never, 'b', { refreshToken: 'token-b', channels: [{ id: 'UC2', title: 'Two' }] }, 'user-1');

	expect(readPendingChannelPick(cookies as never, 'b', 'user-1')).toEqual({
		refreshToken: 'token-b',
		channels: [{ id: 'UC2', title: 'Two' }]
	});
	expect(readPendingChannelPick(cookies as never, 'a', 'user-1')).toEqual({
		refreshToken: 'token-a',
		channels: [{ id: 'UC1', title: 'One' }]
	});
});

test('a pick parked by one user is unreadable by another (shared-browser binding)', () => {
	// Hardening: user B, signed in on a shared machine, must never complete
	// user A's in-flight pick — the parked refresh token belongs to A's Google
	// grant and attaching it to B's org would leak it cross-tenant.
	const cookies = makeCookies();
	parkPendingChannelPick(cookies as never, 's', { refreshToken: 'tok-a', channels: [{ id: 'UC1', title: 'One' }] }, 'user-a');

	expect(readPendingChannelPick(cookies as never, 's', 'user-b')).toBeNull();
	// The parker themselves still reads it — a legitimate completion works.
	expect(readPendingChannelPick(cookies as never, 's', 'user-a')).toEqual({
		refreshToken: 'tok-a',
		channels: [{ id: 'UC1', title: 'One' }]
	});
});

test('read honors the TTL boundary: valid at exactly ten minutes, null one millisecond later', () => {
	vi.useFakeTimers();
	const t0 = new Date('2026-01-01T00:00:00Z').getTime();
	vi.setSystemTime(t0);
	const cookies = makeCookies();
	parkPendingChannelPick(cookies as never, 's', { refreshToken: 'tok', channels: [{ id: 'UC1', title: 'One' }] }, 'user-1');

	vi.setSystemTime(t0 + TTL_MS);
	expect(readPendingChannelPick(cookies as never, 's', 'user-1')).toEqual({
		refreshToken: 'tok',
		channels: [{ id: 'UC1', title: 'One' }]
	});

	vi.setSystemTime(t0 + TTL_MS + 1);
	expect(readPendingChannelPick(cookies as never, 's', 'user-1')).toBeNull();
});

test('read returns null for a forged entry whose timestamp is not a number', () => {
	const cookies = forgedCookies([forgedEntry({ ts: 'soon' })]);

	expect(readPendingChannelPick(cookies as never, 's', 'user-1')).toBeNull();
});

test('read returns null for a forged entry with a non-string or empty refresh token', () => {
	expect(readPendingChannelPick(forgedCookies([forgedEntry({ refreshToken: 42 })]) as never, 's', 'user-1')).toBeNull();
	expect(readPendingChannelPick(forgedCookies([forgedEntry({ refreshToken: '' })]) as never, 's', 'user-1')).toBeNull();
});

test('read returns null for a forged entry whose channels are not a non-empty array', () => {
	expect(readPendingChannelPick(forgedCookies([forgedEntry({ channels: {} })]) as never, 's', 'user-1')).toBeNull();
	expect(readPendingChannelPick(forgedCookies([forgedEntry({ channels: [] })]) as never, 's', 'user-1')).toBeNull();
});

test('read returns null when any parked channel is malformed', () => {
	const malformed: unknown[] = [
		null,
		'not-an-object',
		{ id: 42, title: 'One' },
		{ id: '', title: 'One' },
		{ id: 'UC1', title: 42 },
		{ id: 'UC1' }
	];
	for (const channel of malformed) {
		const cookies = forgedCookies([forgedEntry({ channels: [channel] })]);
		expect(readPendingChannelPick(cookies as never, 's', 'user-1'), `channels: [${JSON.stringify(channel)}]`).toBeNull();
	}
});

test('read returns null when even one of several parked channels is malformed', () => {
	const cookies = forgedCookies([
		forgedEntry({ channels: [{ id: 'UC1', title: 'One' }, { id: 42, title: 'Bad' }] })
	]);

	expect(readPendingChannelPick(cookies as never, 's', 'user-1')).toBeNull();
});

// --- parkPendingChannelPick ------------------------------------------------

test('parking writes an encrypted httpOnly lax cookie with a ten-minute maxAge', () => {
	const cookies = makeCookies();
	parkPendingChannelPick(cookies as never, 's', { refreshToken: 'refresh-token', channels: [{ id: 'UC1', title: 'One' }] }, 'user-1');

	expect(cookies.setCalls).toHaveLength(1);
	const call = cookies.setCalls[0];
	expect(call.name).toBe(CHANNEL_PICK_COOKIE);
	expect(call.opts).toEqual({ path: '/', httpOnly: true, sameSite: 'lax', secure: false, maxAge: 600 });
	// The refresh token never travels in plaintext.
	expect(call.value).not.toContain('refresh-token');
	expect(JSON.parse(decrypt(call.value))).toEqual([
		{ state: 's', ts: expect.any(Number), userId: 'user-1', refreshToken: 'refresh-token', channels: [{ id: 'UC1', title: 'One' }] }
	]);
});

test('parking twice under one state keeps only the newest grant', () => {
	const cookies = makeCookies();
	parkPendingChannelPick(cookies as never, 's', { refreshToken: 'old-token', channels: [{ id: 'UC1', title: 'One' }] }, 'user-1');
	parkPendingChannelPick(cookies as never, 's', { refreshToken: 'new-token', channels: [{ id: 'UC2', title: 'Two' }] }, 'user-1');

	const entries = parkedEntries(cookies);
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({ state: 's', refreshToken: 'new-token' });
});

test('parking under a second state keeps both flows', () => {
	const cookies = makeCookies();
	parkPendingChannelPick(cookies as never, 'a', { refreshToken: 'token-a', channels: [{ id: 'UC1', title: 'One' }] }, 'user-1');
	parkPendingChannelPick(cookies as never, 'b', { refreshToken: 'token-b', channels: [{ id: 'UC2', title: 'Two' }] }, 'user-1');

	expect(parkedEntries(cookies).map((e) => e.state)).toEqual(['a', 'b']);
});

test('parking drops entries at the TTL boundary and keeps fresh ones', () => {
	vi.useFakeTimers();
	const t0 = new Date('2026-01-01T00:00:00Z').getTime();
	vi.setSystemTime(t0);
	const cookies = makeCookies();
	parkPendingChannelPick(cookies as never, 'a', { refreshToken: 'token-a', channels: [{ id: 'UC1', title: 'One' }] }, 'user-1');

	// Exactly at the boundary the older entry is still fresh.
	vi.setSystemTime(t0 + TTL_MS);
	parkPendingChannelPick(cookies as never, 'b', { refreshToken: 'token-b', channels: [{ id: 'UC2', title: 'Two' }] }, 'user-1');
	expect(parkedEntries(cookies).map((e) => e.state)).toEqual(['a', 'b']);

	// One millisecond past it, the oldest entry is dropped on the next park.
	vi.setSystemTime(t0 + TTL_MS + 1);
	parkPendingChannelPick(cookies as never, 'c', { refreshToken: 'token-c', channels: [{ id: 'UC3', title: 'Three' }] }, 'user-1');
	expect(parkedEntries(cookies).map((e) => e.state)).toEqual(['b', 'c']);
});

test('the cookie is bounded to the five newest pending picks', () => {
	const cookies = makeCookies();
	for (const state of ['a', 'b', 'c', 'd', 'e', 'f']) {
		parkPendingChannelPick(cookies as never, state, { refreshToken: `token-${state}`, channels: [{ id: 'UC1', title: 'One' }] }, 'user-1');
	}

	const entries = parkedEntries(cookies);
	expect(entries).toHaveLength(5);
	expect(entries.map((e) => e.state)).toEqual(['b', 'c', 'd', 'e', 'f']);
});

// --- clearPendingChannelPick ------------------------------------------------

test('clear removes only the matching flow and keeps the others', () => {
	const cookies = makeCookies();
	parkPendingChannelPick(cookies as never, 'a', { refreshToken: 'token-a', channels: [{ id: 'UC1', title: 'One' }] }, 'user-1');
	parkPendingChannelPick(cookies as never, 'b', { refreshToken: 'token-b', channels: [{ id: 'UC2', title: 'Two' }] }, 'user-1');

	clearPendingChannelPick(cookies as never, 'a');

	expect(readPendingChannelPick(cookies as never, 'a', 'user-1')).toBeNull();
	expect(readPendingChannelPick(cookies as never, 'b', 'user-1')).toEqual({
		refreshToken: 'token-b',
		channels: [{ id: 'UC2', title: 'Two' }]
	});
	expect(parkedEntries(cookies).map((e) => e.state)).toEqual(['b']);
});

test('clear deletes the cookie at path / when the last entry is removed', () => {
	const cookies = makeCookies();
	parkPendingChannelPick(cookies as never, 's', { refreshToken: 'tok', channels: [{ id: 'UC1', title: 'One' }] }, 'user-1');
	cookies.setCalls.length = 0;

	clearPendingChannelPick(cookies as never, 's');

	expect(cookies.setCalls).toHaveLength(0);
	expect(cookies.deleteCalls).toEqual([{ name: CHANNEL_PICK_COOKIE, opts: { path: '/' } }]);
	expect(cookies.get(CHANNEL_PICK_COOKIE)).toBeUndefined();
});

test('clear deletes the cookie when nothing valid remains', () => {
	// No cookie at all, a tampered cookie, and a non-array payload all reduce
	// to "no entries" — the cookie must be deleted, never rewritten.
	const jars: Jar[] = [makeCookies(), makeCookies(), forgedCookies('nope')];
	jars[1].set(CHANNEL_PICK_COOKIE, 'tampered', { path: '/' });

	for (const cookies of jars) {
		cookies.setCalls.length = 0;
		clearPendingChannelPick(cookies as never, 's');

		expect(cookies.setCalls).toHaveLength(0);
		expect(cookies.deleteCalls).toEqual([{ name: CHANNEL_PICK_COOKIE, opts: { path: '/' } }]);
	}
});

// --- upsertChannelConnection ------------------------------------------------

test('a new channel is inserted with the token encrypted and the scan window opening at connect time', async () => {
	const result = await upsertChannelConnection(OWNER, { id: 'UC1', title: 'One' }, 'refresh-token');

	expect(result).toBe('ok');
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC1', userId: OWNER.id, orgId: OWNER.orgId, title: 'One', active: 1 });
	expect(row?.refreshTokenEnc).not.toBe('refresh-token');
	expect(decrypt(row?.refreshTokenEnc as string)).toBe('refresh-token');
	expect(row?.cursor).toBeTruthy();
	expect(row?.cursor).toBe(row?.createdAt);
});

test('a channel owned by another team is left untouched and reports exactly conflict', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: 'user-2', orgId: 'org-2', title: 'Not yours', refreshTokenEnc: 'foreign-enc' });

	const result = await upsertChannelConnection(OWNER, { id: 'UC1', title: 'One' }, 'refresh-token');

	expect(result).toBe('conflict');
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC1', userId: 'user-2', orgId: 'org-2', title: 'Not yours', refreshTokenEnc: 'foreign-enc' });
});

test('a channel owned by the caller team is updated — the token-handover path', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: 'user-2', orgId: 'org-1', title: 'Old title', refreshTokenEnc: 'old-enc', active: 0 });

	const result = await upsertChannelConnection(OWNER, { id: 'UC1', title: 'One' }, 'refresh-token');

	expect(result).toBe('ok');
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'One', active: 1 });
	expect(decrypt(row?.refreshTokenEnc as string)).toBe('refresh-token');
});

test('an orphan channel is claimed by the connecting team', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: null, orgId: null, title: 'Orphan', refreshTokenEnc: 'old-enc' });

	const result = await upsertChannelConnection(OWNER, { id: 'UC1', title: 'One' }, 'refresh-token');

	expect(result).toBe('ok');
	const row = await testDb().db.select().from(channels).get();
	expect(row).toMatchObject({ id: 'UC1', userId: OWNER.id, orgId: OWNER.orgId });
});

test('channel state: round-trips the starter userId and is opaque to the client', () => {
	const state = createChannelState('user-1');
	expect(state).not.toContain('user-1');
	expect(decodeChannelState(state)).toEqual({ userId: 'user-1' });
	expect(decodeChannelState(state)).toEqual({ userId: 'user-1' }); // deterministic, repeatable reads
});

test('channel state: tampered or forged values decode to null (fail-closed)', () => {
	expect(decodeChannelState('garbage')).toBeNull();
	expect(decodeChannelState(encrypt('not-json'))).toBeNull();
	// A state encrypted for a different user still decodes — to THAT user; the
	// callback compares the decoded starter against the signed-in session.
	expect(decodeChannelState(createChannelState('someone-else'))).toEqual({ userId: 'someone-else' });
});

test('channel state: an expired state decodes to null', () => {
	vi.useFakeTimers();
	try {
		const state = createChannelState('user-1');
		vi.setSystemTime(Date.now() + 11 * 60 * 1000);
		expect(decodeChannelState(state)).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});
