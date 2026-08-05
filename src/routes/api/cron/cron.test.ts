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
	await expect(call(secret)).rejects.toThrowError(expect.objectContaining({ status: 401 }));
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

	await expect(call({ bearer: 'anything' })).rejects.toThrowError(expect.objectContaining({ status: 500 }));
});

test('rejects a malformed Authorization header even with a valid query secret', async () => {
	const url = new URL('http://localhost/api/cron?secret=test-secret');
	const request = new Request(url, { headers: { authorization: 'Basic anything' } });

	await expect(GET({ url, request } as never)).rejects.toThrowError(
		expect.objectContaining({ status: 401 })
	);
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
	await testDb().db.insert(channels).values({ id: 'UC1', title: 'One', refreshTokenEnc: 'enc' });
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

test('does not select or claim a channel whose lease is still held', async () => {
	// Mutation audit: flipping the lease comparison (lt→gt) stayed green
	// because no test ever set leaseExpiresAt — the lease would become an
	// anti-lock, letting concurrent invocations process the same channel.
	const futureLease = new Date(Date.now() + 10 * 60 * 1000).toISOString();
	await testDb().db.insert(channels).values({ id: 'UC-leased', title: 'Leased', refreshTokenEnc: 'enc', leaseExpiresAt: futureLease });

	const res = await call({ bearer: 'test-secret' });

	expect(await res.json()).toMatchObject({ ok: true, results: {} });
	expect(mocks.runChannel).not.toHaveBeenCalled();
});

test('does not select a paused (inactive) channel', async () => {
	// Mutation audit: dropping the active=1 filter stayed green because every
	// seeded channel defaults to active — a channel the user paused would be
	// moderated anyway, against explicit user intent.
	await testDb().db.insert(channels).values({ id: 'UC-paused', title: 'Paused', refreshTokenEnc: 'enc', active: 0 });

	const res = await call({ bearer: 'test-secret' });

	expect(await res.json()).toMatchObject({ ok: true, results: {} });
	expect(mocks.runChannel).not.toHaveBeenCalled();
});

test('selects the least-recently-run channel first', async () => {
	// Mutation audit: asc→desc on lastRunAt stayed green with single-channel
	// fixtures — newest-first lets one hot channel starve the rest (I10).
	await testDb().db.insert(channels).values({ id: 'UC-old', title: 'Old', refreshTokenEnc: 'enc', lastRunAt: '2026-01-01T00:00:00.000Z' });
	await testDb().db.insert(channels).values({ id: 'UC-new', title: 'New', refreshTokenEnc: 'enc', lastRunAt: '2026-08-01T00:00:00.000Z' });
	mocks.runChannel.mockResolvedValue({ fetched: 0, acted: 0, queued: 0, partial: false, skipped: false, dryRun: true });

	await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).toHaveBeenCalledWith('UC-old', expect.anything());
});

test('records the run afterwards: lastRunAt is set and the lease is cleared', async () => {
	// Mutation audit: dropping lastRunAt from the finally-update stayed green —
	// the just-run channel would keep sorting first (SQLite ASC, NULLs first)
	// and starve every other channel.
	await testDb().db.insert(channels).values({ id: 'UC1', title: 'One', refreshTokenEnc: 'enc' });
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
	await testDb().db.insert(channels).values({ id: 'UC-bad', title: 'Bad', refreshTokenEnc: 'enc' });
	mocks.runChannel.mockRejectedValue(new Error('youtube quota exhausted'));
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		const res = await call({ bearer: 'test-secret' });

		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ ok: false, results: { 'UC-bad': { error: 'youtube quota exhausted' } } });
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
	await testDb().db.insert(channels).values({ id: 'UC-live', title: 'Live', refreshTokenEnc: 'enc' });
	mocks.runChannel.mockResolvedValue({ fetched: 0, acted: 0, queued: 0, partial: false, skipped: false, dryRun: false });
	await testDb().client.execute(
		`CREATE TRIGGER fail_consent_update BEFORE UPDATE ON consents
		 BEGIN SELECT RAISE(ABORT, 'simulated sweep failure'); END`
	);
	try {
		const res = await call({ bearer: 'test-secret' });

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.sweepError).toEqual(expect.stringContaining('Failed query'));
		expect(body.consentEmailsNulled).toBe(0);
		expect(mocks.runChannel).toHaveBeenCalledWith('UC-live', expect.objectContaining({ deadline: expect.any(Number) }));
	} finally {
		await testDb().client.execute('DROP TRIGGER fail_consent_update');
	}

	// The failed sweep changed nothing, so the next invocation retries it.
	expect((await testDb().db.select().from(consents).all())[0].email).toBe('old@example.com');
});

test('a dry run skips the consent e-mail sweep entirely (I8)', async () => {
	const oldDate = new Date(Date.now() - CONSENT_EMAIL_RETENTION_MS - DAY_MS).toISOString();
	await seedConsent('old', oldDate);

	const res = await call({ bearer: 'test-secret' });

	expect(await res.json()).toMatchObject({ ok: true, dryRun: true, consentEmailsNulled: 0 });
	expect((await testDb().db.select().from(consents).all())[0].email).toBe('old@example.com');
});
