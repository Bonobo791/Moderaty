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
import { auditLog, channels, comments } from '$lib/server/db/schema';

import { load } from './+layout.server';

/** The layout load's resolved payload — pins the test data instead of `Record<string, any>`. */
type LayoutData = Awaited<ReturnType<typeof load>>;

setupTestDb(['moderation_actions', 'comments', 'audit_log', 'rules', 'channels']);

const OWNER = TEST_OWNER;

function loadLayout(
	channelId: string,
	user: typeof OWNER | null = OWNER,
	path = `/channels/${channelId}`,
	dbDown = false
) {
	return load({
		params: { id: channelId },
		locals: { user, dbDown },
		url: new URL(`https://moderaty.test${path}`)
	} as never);
}

async function seedChannel(id: string, userId: string | null = OWNER.id, orgId: string | null = 'org-1') {
	await testDb().db.insert(channels).values({ id, userId, orgId, title: `Channel ${id}`, refreshTokenEnc: 'enc' });
}

test('loads the channel with pending and banned counts for the header and tab label', async () => {
	await seedChannel('UC1');
	const comment = (id: string, status: string) =>
		testDb().db.insert(comments).values({ id, channelId: 'UC1', text: 'hi', publishedAt: '2026-07-01T00:00:00Z', status, decidedBy: 'ai' });
	await comment('c1', 'pending');
	await comment('c2', 'pending');
	await comment('c3', 'approved');
	const audit = (commentId: string, action: string) =>
		testDb().db.insert(auditLog).values({ channelId: 'UC1', commentId, action, reason: 'r', actor: 'system' });
	await audit('c3', 'ban');
	// Dry-run rows are never ban events.
	await audit('c3', 'dry-run');

	const data = (await loadLayout('UC1')) as LayoutData;

	expect(data.ch).toMatchObject({ id: 'UC1', title: 'Channel UC1' });
	expect(data.pending).toBe(2);
	expect(data.banned).toBe(1);
	expect(data.maintenance).toBe(false);
	expect(data.orgRole).toBe('owner');
	expect(data.tab).toBe('overview');
});

test('never serializes the encrypted refresh token or the drain continuation token', async () => {
	await testDb().db.insert(channels).values({
		id: 'UC1',
		userId: OWNER.id,
		orgId: 'org-1',
		title: 'Mine',
		refreshTokenEnc: 'encrypted-refresh-token',
		nextPageToken: 'secret-page-token'
	});

	const data = (await loadLayout('UC1')) as LayoutData;

	// A mid-drain channel is flagged scanning without leaking the token itself.
	expect(data.ch.scanning).toBe(true);
	expect(data.ch).not.toHaveProperty('refreshTokenEnc');
	expect(data.ch).not.toHaveProperty('nextPageToken');
	expect(JSON.stringify(data)).not.toContain('encrypted-refresh-token');
	expect(JSON.stringify(data)).not.toContain('secret-page-token');
});

test('an idle channel is flagged as not scanning', async () => {
	await seedChannel('UC1');

	const data = (await loadLayout('UC1')) as LayoutData;

	expect(data.ch.scanning).toBe(false);
});

test('projects the tone and protection flags the overview page renders', async () => {
	await testDb().db.insert(channels).values({
		id: 'UC1',
		userId: OWNER.id,
		orgId: 'org-1',
		title: 'Mine',
		refreshTokenEnc: 'enc',
		toneLevel: 2,
		protectLgbtqia: 1,
		protectWomen: 0,
		lastRunAt: '2026-07-30T00:00:00Z'
	});

	const data = (await loadLayout('UC1')) as LayoutData;

	expect(data.ch).toMatchObject({ toneLevel: 2, protectLgbtqia: 1, protectWomen: 0, lastRunAt: '2026-07-30T00:00:00Z' });
});

test('another team\'s channel reads as 404 — existence never leaks', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');

	await expect(loadLayout('UC1')).rejects.toMatchObject({ status: 404 });
});

test('an unknown channel reads as 404', async () => {
	await expect(loadLayout('UC-missing')).rejects.toMatchObject({ status: 404 });
});

test('a signed-out request is rejected with 401', async () => {
	await seedChannel('UC1');

	await expect(loadLayout('UC1', null)).rejects.toMatchObject({ status: 401 });
});

test.each([
	{ path: '/channels/UC1', tab: 'overview' },
	{ path: '/channels/UC1/rules', tab: 'rules' },
	{ path: '/channels/UC1/queue', tab: 'queue' },
	{ path: '/channels/UC1/log', tab: 'log' }
])('derives the active tab "$tab" from $path', async ({ path, tab }) => {
	await seedChannel('UC1');

	const data = (await loadLayout('UC1', OWNER, path)) as LayoutData;

	expect(data.tab).toBe(tab);
});

test('a database outage returns the maintenance payload without requiring a user', async () => {
	const data = (await loadLayout('UC1', null, '/channels/UC1/queue', true)) as LayoutData;

	expect(data.maintenance).toBe(true);
	expect(data.ch).toMatchObject({ id: 'UC1', title: '', scanning: false });
	expect(data.pending).toBe(0);
	expect(data.banned).toBe(0);
	expect(data.orgRole).toBeNull();
	// The tab still derives from the path so the shell is stable when it recovers.
	expect(data.tab).toBe('queue');
});

test('a database failure mid-load degrades to the maintenance payload and logs loudly', async () => {
	await seedChannel('UC1');
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const client = testDb().client;
	const originalExecute = client.execute.bind(client);
	client.execute = (() => Promise.reject(new Error('hrana 502: connect to upstream failed'))) as never;
	let data: LayoutData;
	try {
		data = (await loadLayout('UC1')) as LayoutData;
		expect(errorSpy).toHaveBeenCalledWith('channel layout load failed:', expect.any(Error));
	} finally {
		client.execute = originalExecute;
		errorSpy.mockRestore();
	}
	expect(data!.maintenance).toBe(true);
	expect(data!.ch.id).toBe('UC1');
});

test('a deliberate HttpError mid-load propagates instead of degrading to maintenance', async () => {
	await seedChannel('UC1');
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	let httpError: unknown;
	try {
		error(418, 'teapot');
	} catch (e) {
		httpError = e;
	}
	// ownedChannel's tenancy select (the FIRST db.select) must succeed; the
	// throw lands on the stats select afterwards.
	const originalSelect = testDb().db.select.bind(testDb().db);
	let calls = 0;
	const selectSpy = vi.spyOn(testDb().db, 'select').mockImplementation(((...args: unknown[]) => {
		calls += 1;
		if (calls === 2) throw httpError;
		return (originalSelect as (...a: unknown[]) => unknown)(...args);
	}) as never);
	try {
		await expect(loadLayout('UC1')).rejects.toBe(httpError);
	} finally {
		selectSpy.mockRestore();
		errorSpy.mockRestore();
	}
	expect(errorSpy).not.toHaveBeenCalled();
});
