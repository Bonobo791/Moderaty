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
import { TEST_OWNER, postForm, setupTestDb, testDb } from '$lib/server/testdb';
import { makeCookies } from '$lib/server/testcookies';
import { channels, memberships, organizations, sessions, users } from '$lib/server/db/schema';

// decrypt is mocked so seeds can use opaque placeholders; the action must pass
// each channel's decrypted token to Google's revocation endpoint.
const decryptMock = vi.hoisted(() => vi.fn((_enc: string) => 'refresh-token'));
vi.mock('$lib/server/crypto', () => ({ decrypt: decryptMock }));

import { actions, load } from './+page.server';

setupTestDb([
	'moderation_actions',
	'comments',
	'audit_log',
	'rules',
	'channels',
	'sessions',
	'users',
	'consents',
	'invites',
	'memberships',
	'organizations'
]);

const OWNER = TEST_OWNER;

function loadDashboard(user: typeof OWNER | null = OWNER) {
	return load({ locals: { user } } as never);
}

async function seedActiveUser() {
	await testDb()
		.db.insert(users)
		.values({ id: OWNER.id, googleSub: 'sub-1', email: OWNER.email, displayName: OWNER.displayName });
	// Every real user's org-1 is their personal org (signup / 0012 backfill).
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'One', personalFor: OWNER.id });
	await testDb().db.insert(memberships).values({ userId: OWNER.id, orgId: 'org-1', role: 'owner' });
	await testDb()
		.db.insert(sessions)
		.values({ id: 'sess-1', userId: OWNER.id, expiresAt: '2027-01-01T00:00:00.000Z' });
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'Mine', refreshTokenEnc: 'enc', active: 1 });
}

/** Token revocation succeeds. Returns the fetch spy for assertions. */
function stubRevocation(ok = true) {
	const fetch = vi.fn().mockResolvedValue(new Response('', { status: ok ? 200 : 500 }));
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

async function captureDelete(user: typeof OWNER | null, fields: Record<string, string>) {
	const cookies = makeCookies();
	try {
		const res = await actions.deleteAccount({ request: postForm(fields), locals: { user }, cookies } as never);
		return { res, cookies };
	} catch (e) {
		return { res: e as { status: number; location?: string }, cookies };
	}
}

/** The seeded account is fully intact: not tombstoned, session alive, channel present. */
async function expectAccountUntouched() {
	expect((await testDb().db.select().from(users).all())[0]).toMatchObject({ googleSub: 'sub-1' });
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(1);
	expect(await testDb().db.select().from(channels).all()).toHaveLength(1);
}

test('dashboard load never serializes the encrypted refresh token', async () => {
	await testDb().db.insert(channels).values({
		id: 'UC1',
		userId: OWNER.id,
		orgId: 'org-1',
		title: 'One',
		refreshTokenEnc: 'encrypted-refresh-token',
		cursor: '2026-01-01T00:00:00Z',
		lastRunAt: '2026-07-30T00:00:00Z'
	});

	const data = await loadDashboard();

	expect(data.chs).toHaveLength(1);
	expect(data.chs[0]).toMatchObject({
		id: 'UC1',
		title: 'One',
		cursor: '2026-01-01T00:00:00Z',
		lastRunAt: '2026-07-30T00:00:00Z'
	});
	expect(data.chs[0]).not.toHaveProperty('refreshTokenEnc');
	expect(JSON.stringify(data)).not.toContain('encrypted-refresh-token');
});

test('dashboard load shows only the active team\'s channels', async () => {
	await testDb().db.insert(channels).values({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'Mine', refreshTokenEnc: 'enc' });
	// A teammate's connection is the team's channel too — it MUST appear.
	await testDb().db.insert(channels).values({ id: 'UC2', userId: 'user-2', orgId: 'org-1', title: 'Teammate', refreshTokenEnc: 'enc' });
	// Another team's channel must not leak in.
	await testDb().db.insert(channels).values({ id: 'UC3', userId: 'user-2', orgId: 'org-2', title: 'Theirs', refreshTokenEnc: 'enc' });

	const data = await loadDashboard();

	expect(data.chs.map((ch) => ch.id)).toEqual(['UC1', 'UC2']);
});

test('dashboard load rejects a signed-out request with 401', async () => {
	await expect(loadDashboard(null)).rejects.toMatchObject({ status: 401 });
});

test('delete account rejects a signed-out request with 401', async () => {
	const { res } = await captureDelete(null, { confirm: 'on' });
	expect(res).toMatchObject({ status: 401 });
});

test('delete account without the confirmation checkbox writes nothing', async () => {
	await seedActiveUser();

	const { res } = await captureDelete(OWNER, {});

	expect(res).toMatchObject({ status: 400 });
	await expectAccountUntouched();
});

test('delete account rolls everything back when the erase transaction fails', async () => {
	await seedActiveUser();
	stubRevocation();
	// Force a delete inside the transaction to fail, proving the erase commits
	// as one unit: without the transaction the user would keep a live session
	// on a tombstoned account.
	await testDb().client.execute(
		`CREATE TRIGGER fail_session_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'simulated session deletion failure'); END;`
	);
	let outcome: Awaited<ReturnType<typeof captureDelete>>;
	try {
		outcome = await captureDelete(OWNER, { confirm: 'on' });
	} finally {
		// The test db is shared across tests — never leak the failure trigger.
		await testDb().client.execute('DROP TRIGGER fail_session_delete');
	}

	// Fails loudly: the action rejects (SvelteKit turns that into a 500 with a
	// generic message), it does not redirect, and the session cookie stays.
	expect(outcome.res).toBeInstanceOf(Error);
	expect(outcome.res).not.toMatchObject({ status: 302 });
	expect(outcome.cookies.deleteCalls).toHaveLength(0);
	// Nothing partial persists: no tombstone, session and channel untouched.
	await expectAccountUntouched();
});

test('delete account revokes each channel at Google, erases everything, and signs out', async () => {
	await seedActiveUser();
	const fetch = stubRevocation();

	const { res, cookies } = await captureDelete(OWNER, { confirm: 'on' });

	expect(res).toMatchObject({ status: 302, location: '/' });
	// Revocation used the DECRYPTED refresh token of the owned channel.
	expect(decryptMock).toHaveBeenCalledWith('enc');
	expect(fetch).toHaveBeenCalledWith(
		'https://oauth2.googleapis.com/revoke',
		expect.objectContaining({ method: 'POST' })
	);
	expect(String(fetch.mock.calls[0][1].body)).toContain('token=refresh-token');
	// Immediate deletion: channels and sessions are GONE (not deactivated),
	// and the user row is a fully anonymized tombstone.
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(0);
	expect((await testDb().db.select().from(users).all())[0]).toMatchObject({
		googleSub: 'deleted:user-1',
		email: '[deleted]',
		displayName: '[deleted]'
	});
	expect(cookies.deleteCalls.some((c) => c.name === 'moderaty_session')).toBe(true);
});

test('delete account still deletes when revocation fails, logging loudly', async () => {
	await seedActiveUser();
	stubRevocation(false); // Google answers 500
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	const { res } = await captureDelete(OWNER, { confirm: 'on' });

	expect(res).toMatchObject({ status: 302, location: '/' });
	expect(errorSpy).toHaveBeenCalled();
	// The encrypted token is erased either way — the grant is orphaned, not kept.
	expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
	expect((await testDb().db.select().from(users).all())[0]).toMatchObject({ googleSub: 'deleted:user-1' });
});

test('a revocation failure on one channel does not stop the others', async () => {
	await seedActiveUser();
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC2', userId: OWNER.id, orgId: 'org-1', title: 'Second', refreshTokenEnc: 'enc2', active: 1 });
	decryptMock.mockImplementation((enc: string) => (enc === 'enc2' ? 'token-2' : 'token-1'));
	// Google answers 500 for the first channel's token, 200 for the second.
	const fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
		Promise.resolve(new Response('', { status: String(init?.body).includes('token=token-1') ? 500 : 200 }))
	);
	vi.stubGlobal('fetch', fetch);
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		const { res } = await captureDelete(OWNER, { confirm: 'on' });

		expect(res).toMatchObject({ status: 302, location: '/' });
		// The failure is logged loudly WITH the channel id…
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('UC1'), expect.anything());
		// …and the second channel was still revoked afterwards.
		expect(fetch.mock.calls.some((c) => String(c[1]?.body).includes('token=token-2'))).toBe(true);
		expect(await testDb().db.select().from(channels).all()).toHaveLength(0);
		expect((await testDb().db.select().from(users).all())[0]).toMatchObject({ googleSub: 'deleted:user-1' });
	} finally {
		// The decrypt mock is module-level — restore the default for other tests.
		decryptMock.mockImplementation(() => 'refresh-token');
	}
});
