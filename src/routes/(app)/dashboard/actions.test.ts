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

import { beforeEach, expect, test, vi } from 'vitest';
import { TEST_OWNER, postForm, setupTestDb, testDb } from '$lib/server/testdb';
import { channels } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({ runChannel: vi.fn() }));
vi.mock('$lib/server/pipeline', () => ({ runChannel: mocks.runChannel }));

import { actions } from './+page.server';

setupTestDb(['channels']);

const OWNER = TEST_OWNER;

beforeEach(() => {
	mocks.runChannel.mockReset();
});

async function seedChannel(id: string, userId: string | null = OWNER.id, orgId: string | null = 'org-1') {
	await testDb().db.insert(channels).values({ id, userId, orgId, title: `Channel ${id}`, refreshTokenEnc: 'enc' });
}

function setToneLevel(channelId: string, toneLevel: string, user: typeof OWNER | null = OWNER) {
	return actions.setToneLevel({ request: postForm({ channelId, toneLevel }), locals: { user } } as never);
}

async function toneLevelOf(id: string) {
	const row = await testDb().db.select().from(channels).where(eq(channels.id, id)).get();
	return row?.toneLevel;
}

test.each([{ level: '1' }, { level: '2' }])('persists sensitivity level $level', async ({ level }) => {
	await seedChannel('UC1');

	const res = await setToneLevel('UC1', level);

	expect(res).toMatchObject({ ok: true });
	expect(await toneLevelOf('UC1')).toBe(Number(level));
});

test.each([{ level: '0' }, { level: '3' }, { level: 'x' }, { level: '' }])(
	'rejects invalid sensitivity level "$level" with 400 and changes nothing',
	async ({ level }) => {
		await seedChannel('UC1');

		const res = await setToneLevel('UC1', level);

		expect(res).toMatchObject({
			status: 400,
			data: { error: 'tone level must be 1 (Edge Lord) or 2 (Edge lord + Ackchyually…)' }
		});
		expect(await toneLevelOf('UC1')).toBeNull();
	}
);

test('rejects an unknown channel with 404', async () => {
	const res = await setToneLevel('UC-missing', '2');

	expect(res).toMatchObject({ status: 404, data: { error: 'channel not found' } });
});

test('rejects a channel owned by another team with 404 and changes nothing', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');

	const res = await setToneLevel('UC1', '2');

	expect(res).toMatchObject({ status: 404 });
	expect(await toneLevelOf('UC1')).toBeNull();
});

test('rejects a signed-out request with 401', async () => {
	await seedChannel('UC1');

	await expect(setToneLevel('UC1', '2', null)).rejects.toMatchObject({ status: 401 });
	expect(await toneLevelOf('UC1')).toBeNull();
});

function analyzeHistory(channelId: string, months: string, user: typeof OWNER | null = OWNER) {
	return actions.analyzeHistory({ request: postForm({ channelId, months }), locals: { user } } as never);
}

async function scanWindowOf(id: string) {
	const row = await testDb().db.select().from(channels).where(eq(channels.id, id)).get();
	return { cursor: row?.cursor, nextPageToken: row?.nextPageToken, scanCursor: row?.scanCursor };
}

test('analyze history moves the scan boundary N months back and resets the drain state', async () => {
	await seedChannel('UC1');
	await testDb()
		.db.update(channels)
		.set({ cursor: '2026-07-30T00:00:00.000Z', nextPageToken: 'tok', scanCursor: '2026-07-29T00:00:00.000Z' })
		.where(eq(channels.id, 'UC1'));

	// The request is logged loudly with channel and boundary.
	const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
	try {
		const before = Date.now();
		const res = await analyzeHistory('UC1', '3');
		const after = Date.now();

		expect(res).toMatchObject({ ok: true, scope: 'history', channelId: 'UC1', months: 3 });
		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringMatching(/^history analysis requested for channel UC1: scanning back to /)
		);
		const { cursor, nextPageToken, scanCursor } = await scanWindowOf('UC1');
		expect(nextPageToken).toBeNull();
		expect(scanCursor).toBeNull();
		// 3 months ≈ 90 days back, computed at action time.
		const expected = 3 * 30 * 24 * 60 * 60 * 1000;
		expect(Date.parse(cursor ?? '')).toBeGreaterThanOrEqual(before - expected - 1000);
		expect(Date.parse(cursor ?? '')).toBeLessThanOrEqual(after - expected + 1000);
	} finally {
		infoSpy.mockRestore();
	}
});

test.each([{ months: '0' }, { months: '2' }, { months: '25' }, { months: 'x' }, { months: '' }])(
	'analyze history rejects months "$months" with 400 and changes nothing',
	async ({ months }) => {
		await seedChannel('UC1');
		await testDb()
			.db.update(channels)
			.set({ cursor: '2026-07-30T00:00:00.000Z', nextPageToken: 'tok', scanCursor: '2026-07-29T00:00:00.000Z' })
			.where(eq(channels.id, 'UC1'));

		const res = await analyzeHistory('UC1', months);

		expect(res).toMatchObject({
			status: 400,
			data: {
				scope: 'history',
				channelId: 'UC1',
				error: 'history window must be 1, 3, 6, 12, or 24 months'
			}
		});
		expect(await scanWindowOf('UC1')).toEqual({
			cursor: '2026-07-30T00:00:00.000Z',
			nextPageToken: 'tok',
			scanCursor: '2026-07-29T00:00:00.000Z'
		});
	}
);

test('analyze history rejects an unknown channel with 404', async () => {
	const res = await analyzeHistory('UC-missing', '3');

	expect(res).toMatchObject({
		status: 404,
		data: { scope: 'history', channelId: 'UC-missing', error: 'channel not found' }
	});
});

test('analyze history rejects a channel owned by another team with 404 and changes nothing', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');
	await testDb()
		.db.update(channels)
		.set({ cursor: '2026-07-30T00:00:00.000Z', nextPageToken: 'tok', scanCursor: '2026-07-29T00:00:00.000Z' })
		.where(eq(channels.id, 'UC1'));

	const res = await analyzeHistory('UC1', '3');

	expect(res).toMatchObject({ status: 404 });
	expect(await scanWindowOf('UC1')).toEqual({
		cursor: '2026-07-30T00:00:00.000Z',
		nextPageToken: 'tok',
		scanCursor: '2026-07-29T00:00:00.000Z'
	});
});

test('analyze history rejects a signed-out request with 401', async () => {
	await seedChannel('UC1');

	await expect(analyzeHistory('UC1', '3', null)).rejects.toMatchObject({ status: 401 });
});

test('analyze history returns 409 while the channel is leased to a cron run and changes nothing', async () => {
	await seedChannel('UC1');
	await testDb()
		.db.update(channels)
		.set({
			cursor: '2026-07-30T00:00:00.000Z',
			nextPageToken: 'tok',
			scanCursor: '2026-07-29T00:00:00.000Z',
			leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
		})
		.where(eq(channels.id, 'UC1'));

	const res = await analyzeHistory('UC1', '3');

	expect(res).toMatchObject({
		status: 409,
		data: { scope: 'history', channelId: 'UC1', error: 'This channel is mid-scan — retry in a minute.' }
	});
	// The in-flight run keeps its scan state — the user's boundary is not
	// half-applied underneath it.
	expect(await scanWindowOf('UC1')).toEqual({
		cursor: '2026-07-30T00:00:00.000Z',
		nextPageToken: 'tok',
		scanCursor: '2026-07-29T00:00:00.000Z'
	});
});

test('analyze history proceeds once the lease has expired', async () => {
	await seedChannel('UC1');
	await testDb()
		.db.update(channels)
		.set({ leaseExpiresAt: '2020-01-01T00:00:00.000Z' })
		.where(eq(channels.id, 'UC1'));

	const res = await analyzeHistory('UC1', '3');

	expect(res).toMatchObject({ ok: true });
});

function setProtections(
	channelId: string,
	fields: { protectLgbtqia?: 'on'; protectWomen?: 'on' },
	user: typeof OWNER | null = OWNER
) {
	return actions.setProtections({ request: postForm({ channelId, ...fields }), locals: { user } } as never);
}

async function protectionsOf(id: string) {
	const row = await testDb().db.select().from(channels).where(eq(channels.id, id)).get();
	return { protectLgbtqia: row?.protectLgbtqia, protectWomen: row?.protectWomen };
}

test('set protections persists both flags on', async () => {
	await seedChannel('UC1');

	const res = await setProtections('UC1', { protectLgbtqia: 'on', protectWomen: 'on' });

	expect(res).toMatchObject({ ok: true });
	expect(await protectionsOf('UC1')).toEqual({ protectLgbtqia: 1, protectWomen: 1 });
});

test('set protections persists 0 for an unticked checkbox, clearing a previous 1', async () => {
	await seedChannel('UC1');
	await testDb().db.update(channels).set({ protectLgbtqia: 1, protectWomen: 1 }).where(eq(channels.id, 'UC1'));

	// Only women stays ticked; the absent LGBTQIA+ field must persist 0.
	const res = await setProtections('UC1', { protectWomen: 'on' });

	expect(res).toMatchObject({ ok: true });
	expect(await protectionsOf('UC1')).toEqual({ protectLgbtqia: 0, protectWomen: 1 });
});

test('set protections persists 0 for an unticked women checkbox', async () => {
	await seedChannel('UC1');
	await testDb().db.update(channels).set({ protectLgbtqia: 1, protectWomen: 1 }).where(eq(channels.id, 'UC1'));

	// Only LGBTQIA+ stays ticked; the absent women field must persist 0.
	const res = await setProtections('UC1', { protectLgbtqia: 'on' });

	expect(res).toMatchObject({ ok: true });
	expect(await protectionsOf('UC1')).toEqual({ protectLgbtqia: 1, protectWomen: 0 });
});

test('set protections rejects an unknown channel with 404', async () => {
	const res = await setProtections('UC-missing', { protectLgbtqia: 'on' });

	expect(res).toMatchObject({
		status: 404,
		data: { scope: 'protections', channelId: 'UC-missing', error: 'channel not found' }
	});
});

test('set protections rejects a channel owned by another team with 404 and changes nothing', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');

	const res = await setProtections('UC1', { protectLgbtqia: 'on', protectWomen: 'on' });

	expect(res).toMatchObject({ status: 404 });
	expect(await protectionsOf('UC1')).toEqual({ protectLgbtqia: 0, protectWomen: 0 });
});

test('set protections rejects a signed-out request with 401', async () => {
	await seedChannel('UC1');

	await expect(setProtections('UC1', { protectLgbtqia: 'on' }, null)).rejects.toMatchObject({ status: 401 });
	expect(await protectionsOf('UC1')).toEqual({ protectLgbtqia: 0, protectWomen: 0 });
});

function dryRun(channelId: string, user: typeof OWNER | null = OWNER) {
	return actions.dryRun({ request: postForm({ channelId }), locals: { user } } as never);
}

test('dry run previews a live deployment through runChannel and echoes the counts', async () => {
	await seedChannel('UC1');
	let leaseDuringRun: string | null | undefined;
	mocks.runChannel.mockImplementation(async () => {
		// While the preview runs, the channel must be leased ~60s out so cron
		// cannot claim it underneath the run.
		const ch = await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get();
		leaseDuringRun = ch?.leaseExpiresAt;
		return { fetched: 3, acted: 1, queued: 1, partial: false, skipped: false, dryRun: true };
	});

	const before = Date.now();
	const res = await dryRun('UC1');
	const after = Date.now();

	expect(mocks.runChannel).toHaveBeenCalledWith('UC1', {
		maxPages: 1,
		deadline: expect.any(Number),
		forceDryRun: true
	});
	// One page with a hard 20s ceiling so the preview fits the serverless window.
	const deadline = mocks.runChannel.mock.calls[0][1].deadline as number;
	expect(deadline).toBeGreaterThan(before);
	expect(deadline).toBeLessThanOrEqual(after + 20_000);
	expect(deadline).toBeGreaterThanOrEqual(before + 19_000);
	// The claim lease extends ~60s into the future and self-expires if the
	// request dies mid-preview.
	expect(Date.parse(leaseDuringRun ?? '')).toBeGreaterThanOrEqual(before + 59_000);
	expect(Date.parse(leaseDuringRun ?? '')).toBeLessThanOrEqual(after + 60_000);
	expect(res).toMatchObject({ ok: true, scope: 'dryRun', channelId: 'UC1', fetched: 3, acted: 1, queued: 1, dryRun: true });
	// The preview takes the cron lease atomically and releases it afterwards;
	// a preview is not a run, so lastRunAt is never touched.
	const ch = await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get();
	expect(ch?.leaseExpiresAt).toBeNull();
	expect(ch?.lastRunAt).toBeNull();
});

test('dry run rejects a signed-out request with 401 and never runs', async () => {
	await seedChannel('UC1');

	await expect(dryRun('UC1', null)).rejects.toMatchObject({ status: 401 });
	expect(mocks.runChannel).not.toHaveBeenCalled();
});

test('dry run rejects a channel owned by another team with 404 and never runs', async () => {
	await seedChannel('UC1', 'user-2', 'org-2');

	const res = await dryRun('UC1');

	expect(res).toMatchObject({
		status: 404,
		data: { scope: 'dryRun', channelId: 'UC1', error: 'channel not found' }
	});
	expect(mocks.runChannel).not.toHaveBeenCalled();
});

test('dry run refuses to race a cron run holding the channel lease (409)', async () => {
	await seedChannel('UC1');
	await testDb().db.update(channels).set({ leaseExpiresAt: '2099-01-01T00:00:00.000Z' }).where(eq(channels.id, 'UC1'));

	const res = await dryRun('UC1');

	expect(res).toMatchObject({
		status: 409,
		data: { scope: 'dryRun', channelId: 'UC1', error: 'This channel is mid-scan — retry in a minute.' }
	});
	expect(mocks.runChannel).not.toHaveBeenCalled();
});

test('a failed dry run is loud on the server and a generic 502 to the client', async () => {
	await seedChannel('UC1');
	mocks.runChannel.mockRejectedValue(new Error('raw upstream detail: invalid_grant abc123'));
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const res = (await dryRun('UC1')) as { status: number; data: { error: string } };

		expect(res.status).toBe(502);
		expect(res.data).toEqual({
			scope: 'dryRun',
			channelId: 'UC1',
			error: 'The dry run failed — check the server log and try again.'
		});
		expect(res.data.error).not.toContain('invalid_grant');
		expect(spy).toHaveBeenCalledWith('dry run failed for channel:', 'UC1', expect.any(Error));
		// The lease is released even on failure so cron is never blocked.
		const ch = await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get();
		expect(ch?.leaseExpiresAt).toBeNull();
	} finally {
		spy.mockRestore();
	}
});

test.each([
	{
		name: 'set tone level',
		call: () => actions.setToneLevel({ request: postForm({ toneLevel: '2' }), locals: { user: OWNER } } as never),
		echoes: false
	},
	{
		name: 'set protections',
		call: () => actions.setProtections({ request: postForm({ protectLgbtqia: 'on' }), locals: { user: OWNER } } as never),
		echoes: true
	},
	{
		name: 'analyze history',
		call: () => actions.analyzeHistory({ request: postForm({ months: '3' }), locals: { user: OWNER } } as never),
		echoes: true
	},
	{
		name: 'dry run',
		call: () => actions.dryRun({ request: postForm({}), locals: { user: OWNER } } as never),
		echoes: true
	}
])('$name treats an absent channelId field as empty — never matching any channel', async ({ call, echoes }) => {
	// A channel whose id is exactly what a `?? ''` mutant would substitute:
	// with the field absent, the lookup must still hit nothing.
	await seedChannel('Stryker was here!');

	const res = (await call()) as { status: number; data: Record<string, unknown> };

	expect(res.status).toBe(404);
	if (echoes) expect(res.data.channelId).toBe('');
	// The decoy channel is untouched and nothing ran.
	expect(await toneLevelOf('Stryker was here!')).toBeNull();
	expect(await scanWindowOf('Stryker was here!')).toEqual({ cursor: null, nextPageToken: null, scanCursor: null });
	expect(await protectionsOf('Stryker was here!')).toEqual({ protectLgbtqia: 0, protectWomen: 0 });
	expect(mocks.runChannel).not.toHaveBeenCalled();
});
