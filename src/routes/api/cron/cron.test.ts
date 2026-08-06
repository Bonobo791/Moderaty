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

import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DAY_MS, seedConsent as seedConsentRecord, seedUser, setupTestDb, testDb } from '$lib/server/testdb';
import { channels, consents } from '$lib/server/db/schema';
import { CONSENT_EMAIL_RETENTION_MS } from '$lib/server/deletion';

// Synthetic credential fixture — same maintainer-approved exception as
// netlify/cron.test.mjs (2026-07-30, PR #13 review, per AGENTS.md).
const mocks = vi.hoisted(() => ({
	env: { CRON_SECRET: 'test-secret', DRY_RUN: 'true' } as Record<string, string | undefined>,
	runChannel: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/pipeline', () => ({ runChannel: mocks.runChannel }));

import { GET } from './+server';

setupTestDb(['channels', 'users', 'consents']);

/** Seeds a user with a consent record accepted at `createdAt`, e-mail retained. */
async function seedConsent(id: string, createdAt: string) {
	await seedUser(id);
	await seedConsentRecord(id, createdAt, '1.0');
}

beforeEach(() => {
	mocks.env.CRON_SECRET = 'test-secret';
	mocks.env.DRY_RUN = 'true';
	vi.clearAllMocks();
});

function call(secret?: { query?: string; bearer?: string }) {
	const url = new URL('http://localhost/api/cron');
	if (secret?.query !== undefined) url.searchParams.set('secret', secret.query);
	const headers: Record<string, string> = {};
	if (secret?.bearer !== undefined) headers.authorization = `Bearer ${secret.bearer}`;
	return GET({ url, request: new Request(url, { headers }) } as never);
}

async function expectUnauthorized(secret?: { query?: string; bearer?: string }) {
	// Exact message: a 401 with an empty or wrong message stayed green in the
	// mutation audit (StringLiteral '' on 'bad secret').
	await expect(call(secret)).rejects.toMatchObject({ status: 401, body: { message: 'bad secret' } });
}

/** Seeds a minimal active channel; override any column via `extra`. */
async function seedChannel(id: string, extra: Record<string, unknown> = {}) {
	await testDb()
		.db.insert(channels)
		.values({ id, title: `Channel ${id}`, refreshTokenEnc: 'enc', ...extra });
}

/** Seeds a channel with an in-flight dry-run window drain. */
async function seedDrainChannel(id: string, pageToken: string | null, extra: Record<string, unknown> = {}) {
	await seedChannel(id, { dryRunBoundary: '2026-05-01T00:00:00.000Z', dryRunPageToken: pageToken, ...extra });
}

/** A runChannel result; override only the fields the test asserts on. */
function runResult(overrides: Record<string, unknown> = {}) {
	return { fetched: 0, acted: 0, queued: 0, partial: false, skipped: false, dryRun: true, ...overrides };
}

function channelRow(id: string) {
	return testDb().db.select().from(channels).where(eq(channels.id, id)).get();
}

test('rejects a request with no secret at all', async () => {
	await expectUnauthorized();
});

test('rejects a wrong secret in both query and header', async () => {
	await expectUnauthorized({ query: 'wrong' });
	await expectUnauthorized({ bearer: 'wrong' });
});

test('rejects length-mismatched secrets without throwing a 500', async () => {
	await expectUnauthorized({ bearer: 'x' });
	await expectUnauthorized({ bearer: 'test-secret-but-longer' });
	await expectUnauthorized({ bearer: 'test-secrex' });
});

test('fails loudly when CRON_SECRET is not configured', async () => {
	delete mocks.env.CRON_SECRET;

	// Exact message: an emptied message stayed green in the mutation audit —
	// "fail loudly" means a clear message, not just any 500.
	await expect(call({ bearer: 'anything' })).rejects.toMatchObject({
		status: 500,
		body: { message: 'CRON_SECRET is not configured' }
	});
});

test('rejects a malformed Authorization header even with a valid query secret', async () => {
	const url = new URL('http://localhost/api/cron?secret=test-secret');
	const request = new Request(url, { headers: { authorization: 'Basic anything' } });

	await expect(GET({ url, request } as never)).rejects.toMatchObject({
		status: 401,
		body: { message: 'bad secret' }
	});
});

test('rejects a non-Bearer scheme even when its tail is the secret', async () => {
	// Mutation audit: dropping the 'Bearer ' scheme check (startsWith→true or
	// the literal→'') stayed green because every malformed header happened to
	// slice to a wrong secret. A 7-character scheme prefix ('Digest ', same
	// length as 'Bearer ') whose tail IS the secret must still fail closed —
	// only the Bearer scheme authenticates.
	const url = new URL('http://localhost/api/cron');
	const request = new Request(url, { headers: { authorization: 'Digest test-secret' } });

	await expect(GET({ url, request } as never)).rejects.toMatchObject({
		status: 401,
		body: { message: 'bad secret' }
	});
});

const SECRET_FORMS = [
	{ label: 'plan-documented query secret for manual triggers', secret: { query: 'test-secret' } },
	{ label: 'Authorization bearer secret without a query param', secret: { bearer: 'test-secret' } }
];

test.each(SECRET_FORMS)('accepts the $label', async ({ secret }) => {
	const res = await call(secret);

	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({ ok: true, results: {} });
});

test('runs the channel with a server-side deadline inside the caller abort window', async () => {
	await seedChannel('UC1');
	const before = Date.now();

	await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).toHaveBeenCalledWith('UC1', expect.objectContaining({
		// The scheduled function aborts at 25s; the server must stop before that.
		deadline: expect.any(Number)
	}));
	const deadline = mocks.runChannel.mock.calls[0][1].deadline;
	const windowMs = deadline - before;
	expect(windowMs).toBeGreaterThanOrEqual(19_000);
	expect(windowMs).toBeLessThanOrEqual(21_000);
});

test('holds a 10-minute lease during the run and reports the result under the channel id', async () => {
	// Mutation audit: the claim's lease timestamp and the success body's
	// results map were never asserted — flipping `Date.now() + LEASE_MS` to
	// `-` (an already-expired lease, defeating the crash-recovery window) and
	// emptying `results` both stayed green.
	await seedChannel('UC1');
	const result = { fetched: 0, acted: 0, queued: 0, partial: false, skipped: false, dryRun: true };
	let leaseDuringRun: string | null = null;
	mocks.runChannel.mockImplementation(async () => {
		leaseDuringRun =
			(await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())
				?.leaseExpiresAt ?? null;
		return result;
	});
	const before = Date.now();

	const res = await call({ bearer: 'test-secret' });
	const after = Date.now();

	expect(await res.json()).toMatchObject({ ok: true, results: { UC1: result } });
	// The lease must be held for the whole run and expire ~10 minutes out —
	// long enough to outlast one bounded run, self-expiring after a crash.
	const leaseMs = Date.parse(leaseDuringRun ?? '');
	const TEN_MIN_MS = 10 * 60 * 1000;
	expect(leaseMs).toBeGreaterThanOrEqual(before + TEN_MIN_MS - 1000);
	expect(leaseMs).toBeLessThanOrEqual(after + TEN_MIN_MS + 1000);
});

test('exits cleanly when the atomic claim matches 0 rows (concurrent claimant)', async () => {
	// Mutation audit: the claimed:false early return was never executed, so
	// forcing `claimed.length === 0` to false survived — a losing claimant
	// would run the channel anyway, duplicating moderation work.
	// A BEFORE UPDATE trigger with RAISE(IGNORE) silently skips the claim row
	// (0 rows updated, no error) — the exact post-select race outcome.
	await seedChannel('UC-race');
	await testDb().client.execute(
		`CREATE TRIGGER ignore_channel_claim BEFORE UPDATE ON channels
		 WHEN NEW.lease_expires_at IS NOT NULL
		 BEGIN SELECT RAISE(IGNORE); END`
	);
	try {
		const res = await call({ bearer: 'test-secret' });

		expect(await res.json()).toMatchObject({ ok: true, claimed: false, results: {} });
		expect(mocks.runChannel).not.toHaveBeenCalled();
	} finally {
		await testDb().client.execute('DROP TRIGGER ignore_channel_claim');
	}
});

test('does not select or claim a channel whose lease is still held', async () => {
	// Mutation audit: flipping the lease comparison (lt→gt) stayed green
	// because no test ever set leaseExpiresAt — the lease would become an
	// anti-lock, letting concurrent invocations process the same channel.
	const futureLease = new Date(Date.now() + 10 * 60 * 1000).toISOString();
	await seedChannel('UC-leased', { leaseExpiresAt: futureLease });

	const res = await call({ bearer: 'test-secret' });

	expect(await res.json()).toMatchObject({ ok: true, results: {} });
	expect(mocks.runChannel).not.toHaveBeenCalled();
});

test('does not select a paused (inactive) channel', async () => {
	// Mutation audit: dropping the active=1 filter stayed green because every
	// seeded channel defaults to active — a channel the user paused would be
	// moderated anyway, against explicit user intent.
	await seedChannel('UC-paused', { active: 0 });

	const res = await call({ bearer: 'test-secret' });

	expect(await res.json()).toMatchObject({ ok: true, results: {} });
	expect(mocks.runChannel).not.toHaveBeenCalled();
});

test('selects the least-recently-run channel first', async () => {
	// Mutation audit: asc→desc on lastRunAt stayed green with single-channel
	// fixtures — newest-first lets one hot channel starve the rest (I10).
	await seedChannel('UC-old', { lastRunAt: '2026-01-01T00:00:00.000Z' });
	await seedChannel('UC-new', { lastRunAt: '2026-08-01T00:00:00.000Z' });
	mocks.runChannel.mockResolvedValue({ fetched: 0, acted: 0, queued: 0, partial: false, skipped: false, dryRun: true });

	await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).toHaveBeenCalledWith('UC-old', expect.anything());
});

test('records the run afterwards: lastRunAt is set and the lease is cleared', async () => {
	// Mutation audit: dropping lastRunAt from the finally-update stayed green —
	// the just-run channel would keep sorting first (SQLite ASC, NULLs first)
	// and starve every other channel.
	await seedChannel('UC1');
	mocks.runChannel.mockResolvedValue({ fetched: 0, acted: 0, queued: 0, partial: false, skipped: false, dryRun: true });

	await call({ bearer: 'test-secret' });

	const row = await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get();
	expect(row?.lastRunAt).not.toBeNull();
	expect(row?.leaseExpiresAt).toBeNull();
});

test('a failing channel run reports failure, never success', async () => {
	// Mutation audit: no test made runChannel reject, so the failure path
	// returning ok:true / 200 stayed green — monitoring would see a failing
	// channel as healthy (the code comment's exact warning).
	await seedChannel('UC-bad');
	mocks.runChannel.mockRejectedValue(new Error('youtube quota exhausted'));
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		const res = await call({ bearer: 'test-secret' });

		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ ok: false, results: { 'UC-bad': { error: 'youtube quota exhausted' } } });
		// The failure is logged loudly with the channel id (an emptied log
		// message stayed green in the mutation audit).
		expect(errorSpy).toHaveBeenCalledWith('channel run UC-bad failed:', expect.any(Error));
		// The run is still recorded, so a failing channel cannot starve the others.
		const row = await testDb().db.select().from(channels).where(eq(channels.id, 'UC-bad')).get();
		expect(row?.lastRunAt).not.toBeNull();
		expect(row?.leaseExpiresAt).toBeNull();
	} finally {
		// Restore the spy — a lingering console.error mock leaks into later tests.
		errorSpy.mockRestore();
	}
});

test('erases consent e-mails older than 10 years, keeping the anonymized row', async () => {
	mocks.env.DRY_RUN = 'false';
	const oldDate = new Date(Date.now() - CONSENT_EMAIL_RETENTION_MS - DAY_MS).toISOString();
	const recentDate = new Date(Date.now() - 30 * DAY_MS).toISOString();
	await seedConsent('old', oldDate);
	await seedConsent('recent', recentDate);

	const res = await call({ bearer: 'test-secret' });

	expect(await res.json()).toMatchObject({ ok: true, consentEmailsNulled: 1 });
	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toHaveLength(2);
	// The ROW is kept (doc version, checkbox text, timestamps) — anonymized evidence.
	expect(rows.find((row) => row.userId === 'old')).toMatchObject({ email: null, docVersion: '1.0' });
	expect(rows.find((row) => row.userId === 'recent')).toMatchObject({ email: 'recent@example.com' });
});

test('a sweep failure is reported and does not stop the channel run', async () => {
	mocks.env.DRY_RUN = 'false';
	const oldDate = new Date(Date.now() - CONSENT_EMAIL_RETENTION_MS - DAY_MS).toISOString();
	await seedConsent('old', oldDate);
	await seedChannel('UC-live');
	mocks.runChannel.mockResolvedValue({ fetched: 0, acted: 0, queued: 0, partial: false, skipped: false, dryRun: false });
	await testDb().client.execute(
		`CREATE TRIGGER fail_consent_update BEFORE UPDATE ON consents
		 BEGIN SELECT RAISE(ABORT, 'simulated sweep failure'); END`
	);
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const res = await call({ bearer: 'test-secret' });

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.sweepError).toEqual(expect.stringContaining('Failed query'));
		expect(body.consentEmailsNulled).toBe(0);
		expect(mocks.runChannel).toHaveBeenCalledWith('UC-live', expect.objectContaining({ deadline: expect.any(Number) }));
		// The sweep failure is logged loudly (an emptied log message stayed
		// green in the mutation audit).
		expect(errorSpy).toHaveBeenCalledWith('consent e-mail retention sweep failed:', expect.any(Error));
	} finally {
		errorSpy.mockRestore();
		await testDb().client.execute('DROP TRIGGER fail_consent_update');
	}

	// The failed sweep changed nothing, so the next invocation retries it.
	expect((await testDb().db.select().from(consents).all())[0].email).toBe('old@example.com');
});

test('a dry run skips the consent e-mail sweep entirely (I8)', async () => {
	const oldDate = new Date(Date.now() - CONSENT_EMAIL_RETENTION_MS - DAY_MS).toISOString();
	await seedConsent('old', oldDate);
	// The skipped sweep is announced loudly (an emptied/removed notice stayed
	// green in the mutation audit).
	const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

	try {
		const res = await call({ bearer: 'test-secret' });

		expect(await res.json()).toMatchObject({ ok: true, dryRun: true, consentEmailsNulled: 0 });
		expect(infoSpy).toHaveBeenCalledWith('dry run: consent e-mail retention sweep skipped');
	} finally {
		infoSpy.mockRestore();
	}
	expect((await testDb().db.select().from(consents).all())[0].email).toBe('old@example.com');
});

test('drains one dry-run window page after the normal run and persists the continuation', async () => {
	await seedDrainChannel('UC1', 'tok-1');
	const normal = runResult({ fetched: 2, acted: 1 });
	const drain = runResult({ fetched: 100, acted: 4, queued: 1, windowComplete: false, windowNextPageToken: 'tok-2' });
	mocks.runChannel.mockResolvedValueOnce(normal).mockResolvedValueOnce(drain);

	const res = await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).toHaveBeenCalledTimes(2);
	expect(mocks.runChannel).toHaveBeenNthCalledWith(2, 'UC1', {
		deadline: expect.any(Number),
		forceDryRun: true,
		window: { boundary: '2026-05-01T00:00:00.000Z', pageToken: 'tok-1' }
	});
	expect(await res.json()).toMatchObject({ ok: true, results: { UC1: normal }, dryRunWindow: drain });
	const row = await channelRow('UC1');
	expect(row?.dryRunPageToken).toBe('tok-2');
	expect(row?.dryRunBoundary).toBe('2026-05-01T00:00:00.000Z'); // boundary stays until the window completes
});

test('clears the drain state when the dry-run window completes', async () => {
	await seedDrainChannel('UC1', 'tok-9');
	mocks.runChannel
		.mockResolvedValueOnce(runResult())
		.mockResolvedValueOnce(runResult({ fetched: 40, acted: 1, windowComplete: true, windowNextPageToken: null }));

	await call({ bearer: 'test-secret' });

	const row = await channelRow('UC1');
	expect(row?.dryRunBoundary).toBeNull();
	expect(row?.dryRunPageToken).toBeNull();
});

test('a channel with a drain in flight is selected before older ordinary channels', async () => {
	// Otherwise a busy rotation would starve the drain (a preview the user is
	// actively waiting on) behind every ordinary channel.
	await seedChannel('UC-old', { lastRunAt: '2026-01-01T00:00:00.000Z' });
	await seedDrainChannel('UC-drain', null, { lastRunAt: '2026-08-01T00:00:00.000Z' });
	mocks.runChannel.mockResolvedValue(runResult({ windowComplete: true, windowNextPageToken: null }));

	await call({ bearer: 'test-secret' });

	expect(mocks.runChannel.mock.calls[0][0]).toBe('UC-drain');
});

test('a drain failure is loud, surfaced in the payload, and never masks the normal run', async () => {
	await seedDrainChannel('UC1', 'tok-1');
	const normal = runResult({ fetched: 2, acted: 1 });
	mocks.runChannel.mockResolvedValueOnce(normal).mockRejectedValueOnce(new Error('drain exploded'));
	const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => spy.mockRestore());

	const res = await call({ bearer: 'test-secret' });

	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({ ok: true, results: { UC1: normal }, dryRunWindow: { error: 'drain exploded' } });
	// Exact message: an emptied or altered log line must fail this test.
	expect(spy).toHaveBeenCalledWith('dry-run window drain failed for channel:', 'UC1', expect.any(Error));
	// The drain state is untouched so the next invocation retries it.
	const row = await channelRow('UC1');
	expect(row?.dryRunBoundary).toBe('2026-05-01T00:00:00.000Z');
	expect(row?.dryRunPageToken).toBe('tok-1');
});

test('a channel without a drain runs once and reports no window work', async () => {
	await seedChannel('UC1');
	mocks.runChannel.mockResolvedValue(runResult());

	const res = await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).toHaveBeenCalledTimes(1);
	const body = await res.json();
	expect(body.dryRunWindow).toBeUndefined();
});

test('a preview replanted mid-invocation survives a stale drain completing', async () => {
	// Cron reads the channel row BEFORE the atomic claim; a dashboard preview
	// can claim, replant a NEW window, and release in between. The stale
	// drain's cleanup must not wipe the replacement state.
	await seedDrainChannel('UC1', 'tok-1');
	mocks.runChannel
		.mockResolvedValueOnce(runResult({ fetched: 1 }))
		.mockImplementationOnce(async () => {
			await testDb()
				.db.update(channels)
				.set({ dryRunBoundary: '2026-06-01T00:00:00.000Z', dryRunPageToken: 'fresh-token' })
				.where(eq(channels.id, 'UC1'));
			return runResult({ windowComplete: true, windowNextPageToken: null });
		});

	await call({ bearer: 'test-secret' });

	const row = await channelRow('UC1');
	expect(row?.dryRunBoundary).toBe('2026-06-01T00:00:00.000Z');
	expect(row?.dryRunPageToken).toBe('fresh-token');
});

test('a preview replanted mid-invocation survives a stale drain continuation write', async () => {
	// Same race, incomplete drain: the OLD window's next-page token must not be
	// written over the NEW window's state.
	await seedDrainChannel('UC1', 'tok-1');
	mocks.runChannel
		.mockResolvedValueOnce(runResult({ fetched: 1 }))
		.mockImplementationOnce(async () => {
			await testDb()
				.db.update(channels)
				.set({ dryRunBoundary: '2026-06-01T00:00:00.000Z', dryRunPageToken: 'fresh-token' })
				.where(eq(channels.id, 'UC1'));
			return runResult({ windowComplete: false, windowNextPageToken: 'tok-2' });
		});

	await call({ bearer: 'test-secret' });

	const row = await channelRow('UC1');
	expect(row?.dryRunBoundary).toBe('2026-06-01T00:00:00.000Z');
	expect(row?.dryRunPageToken).toBe('fresh-token');
});
