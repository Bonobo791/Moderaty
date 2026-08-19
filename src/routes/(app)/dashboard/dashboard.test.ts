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

import { expect, test, vi } from 'vitest';
import { error } from '@sveltejs/kit';
import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, comments, memberships, organizations, sessions, users } from '$lib/server/db/schema';

import { load } from './+page.server';

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

test('dashboard load never serializes the encrypted refresh token', async () => {	await testDb().db.insert(channels).values({
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

// A history drain in flight is exactly `nextPageToken IS NOT NULL` (the
// pipeline clears it on completion). The dashboard flags it so the "scan
// started" message survives a refresh — the drain is server-side cron work.
test('dashboard load flags a mid-drain channel as scanning without leaking the page token', async () => {
	await testDb().db.insert(channels).values({
		id: 'UC1',
		userId: OWNER.id,
		orgId: 'org-1',
		title: 'Draining',
		refreshTokenEnc: 'enc',
		nextPageToken: 'secret-page-token'
	});
	await testDb().db
		.insert(channels)
		.values({ id: 'UC2', userId: OWNER.id, orgId: 'org-1', title: 'Idle', refreshTokenEnc: 'enc' });

	const data = await loadDashboard();

	expect(data.chs.find((ch) => ch.id === 'UC1')).toMatchObject({ scanning: true });
	expect(data.chs.find((ch) => ch.id === 'UC2')).toMatchObject({ scanning: false });
	// The continuation token is internal drain state — never serialized.
	expect(data.chs.find((ch) => ch.id === 'UC1')).not.toHaveProperty('nextPageToken');
	expect(JSON.stringify(data)).not.toContain('secret-page-token');
});

test('dashboard load shows only the active team\'s channels', async () => {
	await testDb().db.insert(channels).values({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'Mine', refreshTokenEnc: 'enc' });
	// A teammate's connection is the team's channel too — it MUST appear.
	await testDb().db.insert(channels).values({ id: 'UC2', userId: 'user-2', orgId: 'org-1', title: 'Teammate', refreshTokenEnc: 'enc' });
	// Another team's channel must not leak in.
	await testDb().db.insert(channels).values({ id: 'UC3', userId: 'user-2', orgId: 'org-2', title: 'Theirs', refreshTokenEnc: 'enc' });

	const data = await loadDashboard();

	expect(data.chs.map((ch) => ch.id)).toEqual(['UC1', 'UC2']);
	// A healthy load is explicitly NOT the maintenance overlay.
	expect(data.maintenance).toBe(false);
});

test('dashboard load returns empty stats and bans when the team has no channels', async () => {
	const data = await loadDashboard();

	expect(data.chs).toEqual([]);
	expect(data.stats).toEqual([]);
	expect(data.bans).toEqual([]);
});

test('dashboard load counts comments by status and ban events only, scoped to the team', async () => {
	await testDb().db.insert(channels).values({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'Mine', refreshTokenEnc: 'enc' });
	await testDb().db.insert(channels).values({ id: 'UC3', userId: 'user-2', orgId: 'org-2', title: 'Theirs', refreshTokenEnc: 'enc' });
	const comment = (id: string, channelId: string, status: string) =>
		testDb().db.insert(comments).values({ id, channelId, text: 'hi', publishedAt: '2026-07-01T00:00:00Z', status, decidedBy: 'ai' });
	await comment('c1', 'UC1', 'approved');
	await comment('c2', 'UC1', 'approved');
	await comment('c3', 'UC1', 'held');
	// Another team's comments must not leak into the counts.
	await comment('c4', 'UC3', 'approved');
	await comment('c5', 'UC3', 'approved');
	const audit = (channelId: string, commentId: string, action: string) =>
		testDb().db.insert(auditLog).values({ channelId, commentId, action, reason: 'r', actor: 'system' });
	await audit('UC1', 'c1', 'ban');
	await audit('UC1', 'c2', 'ban');
	// Non-ban actions — including dry-run rows — are never ban events.
	await audit('UC1', 'c3', 'dry-run');
	await audit('UC1', 'c3', 'reject');
	// Another team's bans must not leak into the counts.
	await audit('UC3', 'c4', 'ban');

	const data = await loadDashboard();

	expect(data.stats).toHaveLength(2);
	expect(data.stats).toContainEqual({ channelId: 'UC1', status: 'approved', n: 2 });
	expect(data.stats).toContainEqual({ channelId: 'UC1', status: 'held', n: 1 });
	expect(data.bans).toEqual([{ channelId: 'UC1', n: 2 }]);
});

test('dashboard load rejects a signed-out request with 401', async () => {
	await expect(loadDashboard(null)).rejects.toMatchObject({ status: 401 });
});

test('dashboard load projects the protection flags for each channel', async () => {
	await testDb().db.insert(channels).values({
		id: 'UC1',
		userId: OWNER.id,
		orgId: 'org-1',
		title: 'Mine',
		refreshTokenEnc: 'enc',
		protectLgbtqia: 1,
		protectWomen: 0
	});

	const data = await loadDashboard();

	expect(data.chs[0]).toMatchObject({ protectLgbtqia: 1, protectWomen: 0 });
});

test('a database outage returns the maintenance payload without requiring a user', async () => {
	// dbDown with a null user is the normal outage shape: requireUser must not
	// trip — the overlay replaces the dashboard, not the error page.
	const data = (await load({ locals: { user: null, dbDown: true } } as never)) as Record<string, unknown>;
	expect(data).toEqual({ chs: [], stats: [], bans: [], maintenance: true, orgRole: null });
});

test('a database failure mid-load degrades to the maintenance payload and logs loudly', async () => {
	await seedActiveUser();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const client = testDb().client;
	const originalExecute = client.execute.bind(client);
	client.execute = (() => Promise.reject(new Error('hrana 502: connect to upstream failed'))) as never;
	let data: Record<string, unknown>;
	try {
		data = (await load({ locals: { user: OWNER } } as never)) as Record<string, unknown>;
	} finally {
		client.execute = originalExecute;
	}
	expect(data).toEqual({ chs: [], stats: [], bans: [], maintenance: true, orgRole: null });
	expect(console.error).toHaveBeenCalledWith('dashboard load failed:', expect.any(Error));
});

test('a deliberate HttpError mid-load propagates instead of degrading to maintenance', async () => {
	await seedActiveUser();
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	// Capture a real HttpError (what a downstream helper throws on purpose).
	let httpError: unknown;
	try {
		error(418, 'teapot');
	} catch (e) {
		httpError = e;
	}
	// A direct throw from the db layer is NOT wrapped by drizzle (unlike a
	// rejected client promise, which surfaces as DrizzleQueryError).
	const selectSpy = vi.spyOn(testDb().db, 'select').mockImplementation(() => {
		throw httpError;
	});
	try {
		await expect(load({ locals: { user: OWNER } } as never)).rejects.toBe(httpError);
	} finally {
		selectSpy.mockRestore();
		errorSpy.mockRestore();
	}
	// Not swallowed, not logged as an outage.
	expect(errorSpy).not.toHaveBeenCalled();
});
