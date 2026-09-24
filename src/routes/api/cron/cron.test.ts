import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DAY_MS, seedConsent as seedConsentRecord, seedUser, setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, consents, moderationActions } from '$lib/server/db/schema';
import { AUDIT_HANDLE_RETENTION_MS, CONSENT_EMAIL_RETENTION_MS } from '$lib/server/deletion';

// Synthetic credential fixture — same maintainer-approved exception as
// netlify/cron.test.mjs (2026-07-30, PR #13 review, per AGENTS.md).
const mocks = vi.hoisted(() => ({
	env: { CRON_SECRET: 'test-secret', DRY_RUN: 'true' } as Record<string, string | undefined>,
	runChannel: vi.fn(),
	retryStripeCustomerDeletions: vi.fn(async (_limit: number, _deadline: number) => 0)
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/pipeline', () => ({ runChannel: mocks.runChannel }));
vi.mock('$lib/server/deletion', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/deletion')>();
	// Spy on just the outbox retry (the other deletion sweeps stay real) so a
	// test can pin the shared deadline the route hands it.
	return { ...actual, retryStripeCustomerDeletions: mocks.retryStripeCustomerDeletions };
});

import { GET } from './+server';

setupTestDb(['channels', 'users', 'consents', 'audit_log', 'moderation_actions']);

/** Seeds a user with a consent record accepted at `createdAt`, e-mail retained. */
async function seedConsent(id: string, createdAt: string) {
	await seedUser(id);
	await seedConsentRecord(id, createdAt, '1.0');
}

/** Seeds one audit row with a stored commenter handle at `createdAt`. */
async function seedHandledAuditRow(commentId: string, createdAt: string) {
	await testDb().db.insert(auditLog).values({
		channelId: 'UC-log',
		commentId,
		action: 'reject',
		reason: 'ai score 0.91',
		actor: 'system',
		authorHandle: '@some.user',
		createdAt
	});
}

/** Seeds one moderation action row with a stored commenter handle at `createdAt`. */
async function seedHandledActionRow(commentId: string, createdAt: string) {
	await testDb().db.insert(moderationActions).values({
		commentId,
		channelId: 'UC-log',
		action: 'ban',
		reason: 'rule #1 (user: troll)',
		state: 'completed',
		authorHandle: '@some.user',
		createdAt
	});
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

function expectDrainState(row: Awaited<ReturnType<typeof channelRow>>, boundary: string | null, pageToken: string | null) {
	expect(row?.dryRunBoundary).toBe(boundary);
	expect(row?.dryRunPageToken).toBe(pageToken);
}

test('rejects a request with no secret at all', async () => {
	await expectUnauthorized();
});

test('the stripe deletion outbox retry shares the cron deadline (bounded, never eats the moderation window)', async () => {
	// Each outbox deletion can carry SDK network retries; a sweep without the
	// shared deadline could consume the whole serverless window before a
	// channel is even claimed, repeatedly starving moderation (codex review).
	mocks.env.DRY_RUN = 'false';
	mocks.retryStripeCustomerDeletions.mockClear();

	await call({ query: 'test-secret' });

	expect(mocks.retryStripeCustomerDeletions).toHaveBeenCalledTimes(1);
	const [limit, deadline] = mocks.retryStripeCustomerDeletions.mock.calls[0] as [number, number];
	expect(limit).toBe(10);
	expect(typeof deadline).toBe('number');
	expect(deadline).toBeGreaterThan(Date.now() - 30_000); // a live budget, not the past
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
		// The response carries the sanitized category, never the raw provider
		// message — error bodies can echo request details/tokens (codeant,
		// PR #142). The full error stays in the server log.
		expect(await res.json()).toMatchObject({ ok: false, results: { 'UC-bad': { error: 'quota' } } });
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

test('a deadline-partial run records failed/timeout health, never success', async () => {
	// codex+cubic, PR #142: runChannel RESOLVES deadline exhaustion as
	// { partial: true } — recording success would count a timed-out channel as
	// protected and advance lastSuccessAt on a check that did not complete.
	await seedChannel('UC-partial', { lastRunStatus: 'success', lastSuccessAt: '2026-08-01T00:00:00.000Z' });
	mocks.runChannel.mockResolvedValue(runResult({ dryRun: false, partial: true, stoppedReason: 'deadline' }));

	const res = await call({ bearer: 'test-secret' });

	expect(res.status).toBe(200);
	const row = await channelRow('UC-partial');
	expect(row?.lastRunStatus).toBe('failed');
	expect(row?.lastRunError).toBe('timeout');
	expect(row?.lastSuccessAt).toBe('2026-08-01T00:00:00.000Z'); // frozen — no false freshness
	expect(row?.lastRunAt).not.toBeNull(); // rotation still ticks
	expect(row?.leaseExpiresAt).toBeNull();
});

test('a credit-starved run records failed/credits health, never success', async () => {
	// codex, PR #142: outOfCredits also resolves — the channel fetched comments
	// but deferred every AI decision, so "Protected" would be a lie; the
	// category tells the user the actionable fix (top up), not a reconnect.
	await seedChannel('UC-credits', { lastRunStatus: 'success', lastSuccessAt: '2026-08-01T00:00:00.000Z' });
	mocks.runChannel.mockResolvedValue(runResult({ dryRun: false, outOfCredits: true }));

	const res = await call({ bearer: 'test-secret' });

	expect(res.status).toBe(200);
	const row = await channelRow('UC-credits');
	expect(row?.lastRunStatus).toBe('failed');
	expect(row?.lastRunError).toBe('credits');
	expect(row?.lastSuccessAt).toBe('2026-08-01T00:00:00.000Z');
});

test.each([
	{ label: 'deactivated mid-run', result: { partial: true, stoppedReason: 'deactivated' } },
	{ label: 'skipped as inactive', result: { skipped: true } }
])('a run with no verdict ($label) leaves the prior health verdict untouched', async ({ result }) => {
	// A paused channel's Paused badge comes from active=0, not the run-health
	// columns — stamping failed/timeout would lie on resume, stamping success
	// would lie about a check that never completed. Neither is written.
	await seedChannel('UC-paused', { lastRunStatus: 'success', lastSuccessAt: '2026-08-01T00:00:00.000Z', lastRunError: null });
	mocks.runChannel.mockResolvedValue(runResult(result));

	const res = await call({ bearer: 'test-secret' });

	expect(res.status).toBe(200);
	const row = await channelRow('UC-paused');
	expect(row?.lastRunStatus).toBe('success');
	expect(row?.lastSuccessAt).toBe('2026-08-01T00:00:00.000Z');
	expect(row?.lastRunAt).not.toBeNull();
	expect(row?.leaseExpiresAt).toBeNull();
});

test('a failing channel run reports failure, never success', async () => {
	// MOD-7: health lives apart from the rotation timestamp — a channel that
	// failed before must read healthy again only after a real success.
	await seedChannel('UC-ok', { lastRunStatus: 'failed', lastRunError: 'quota' });
	mocks.runChannel.mockResolvedValue(runResult({ dryRun: false }));

	const res = await call({ bearer: 'test-secret' });

	expect(res.status).toBe(200);
	const row = await channelRow('UC-ok');
	expect(row?.lastRunStatus).toBe('success');
	expect(row?.lastSuccessAt).not.toBeNull();
	expect(row?.lastRunError).toBeNull();
	expect(row?.lastRunAt).not.toBeNull();
	expect(row?.leaseExpiresAt).toBeNull();
});

test.each([
	{ label: 'token', message: 'google oauth refresh failed: 401 unauthorized_client', category: 'token' },
	{ label: 'expired access token', message: 'youtube access token expired', category: 'token' },
	{ label: 'OpenAI', message: 'OpenAI scoring request failed: 500 Internal Server Error', category: 'scoring' },
	{ label: 'moderation response', message: 'moderation response has missing or out-of-range category scores', category: 'scoring' },
	{ label: 'moderation request failure', message: 'moderation failed: 503 service unavailable', category: 'scoring' },
	{ label: 'quota', message: 'commentThreads.list failed: 403 quotaExceeded', category: 'quota' },
	{ label: 'generic', message: 'database is locked', category: 'error' },
	// cubic+coderabbit, PR #142: a YouTube pagination failure is NOT an auth
	// failure — "reconnect the channel" would send the user on a false errand.
	{ label: 'expired page token', message: 'The request specifies an invalid page token.', category: 'error' },
	// cubic, PR #142: a YouTube moderation-action verification failure is not
	// an AI scoring failure — the word "moderation" alone must not win.
	{ label: 'action verification', message: 'moderation action c1 verification failed: 500 Internal Server Error', category: 'error' },
	{ label: 'moderationStatus validation', message: 'comments.list response moderationStatus is unsupported: x', category: 'error' }
])('a failed run persists failed health for a $label failure and never touches the success fields', async ({ message, category }) => {
	// MOD-7: a failed run must not update the success timestamp/status — the
	// dashboard's "last checked" freshness used to lie because only
	// lastRunAt existed. Only the sanitized category is stored: provider
	// error bodies can echo request details and stay in the server log.
	await seedChannel('UC-fail', { lastRunStatus: 'success', lastSuccessAt: '2026-08-01T00:00:00.000Z' });
	mocks.runChannel.mockRejectedValue(new Error(message));
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		const res = await call({ bearer: 'test-secret' });

		expect(res.status).toBe(500);
		const row = await channelRow('UC-fail');
		expect(row?.lastRunStatus).toBe('failed');
		expect(row?.lastRunError).toBe(category);
		// Success fields are frozen at their prior values — the failure
		// cannot masquerade as a healthy run (nor erase when it last was).
		expect(row?.lastSuccessAt).toBe('2026-08-01T00:00:00.000Z');
		expect(row?.lastRunAt).not.toBeNull(); // rotation still ticks so others are not starved
		expect(row?.leaseExpiresAt).toBeNull();
	} finally {
		errorSpy.mockRestore();
	}
});

test('a bookkeeping failure in the run-recording finally cannot mask the run result', async () => {
	// codeant, PR #142: the health write runs in `finally` — an unchecked throw
	// would replace the run's real response and leave the lease uncleared.
	// The lease self-expires; the write failure is logged loudly and the
	// run result still reaches the caller.
	await seedChannel('UC-rec');
	mocks.runChannel.mockResolvedValue(runResult());
	// Only the health write sets last_run_at — the claim's lease write leaves
	// it untouched, so this trigger fires exactly on the finally UPDATE.
	await testDb().client.execute(
		`CREATE TRIGGER fail_run_record BEFORE UPDATE ON channels
		 WHEN NEW.last_run_at IS NOT NULL
		 BEGIN SELECT RAISE(ABORT, 'simulated bookkeeping failure'); END`
	);
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const res = await call({ bearer: 'test-secret' });

		expect(res.status).toBe(200);
		// codex, PR #142 r2: the run result is preserved, but the bookkeeping
		// failure is surfaced in the payload — a silent server-log-only
		// fallback would hide a degraded state from the scheduled caller.
		expect(await res.json()).toMatchObject({ results: { 'UC-rec': runResult() }, bookkeepingError: true });
		expect(errorSpy).toHaveBeenCalledWith('run-health write failed for channel:', 'UC-rec', expect.any(Error));
	} finally {
		errorSpy.mockRestore();
		await testDb().client.execute('DROP TRIGGER fail_run_record');
	}
});

test('a dry-run result writes no health verdict — preview work is not a live check (codex, PR #142)', async () => {
	// DRY_RUN=true deployments resolve every run with dryRun: true; stamping
	// success/lastSuccessAt would label a channel Protected though it never
	// moderated anything live. lastRunAt still ticks (rotation) and the
	// lease still clears.
	await seedChannel('UC-dry', { lastRunStatus: 'failed', lastRunError: 'quota', lastSuccessAt: '2026-08-01T00:00:00.000Z' });
	mocks.runChannel.mockResolvedValue(runResult()); // dryRun: true default

	const res = await call({ bearer: 'test-secret' });

	expect(res.status).toBe(200);
	const row = await channelRow('UC-dry');
	expect(row?.lastRunStatus).toBe('failed');
	expect(row?.lastRunError).toBe('quota');
	expect(row?.lastSuccessAt).toBe('2026-08-01T00:00:00.000Z');
	expect(row?.lastRunAt).not.toBeNull();
	expect(row?.leaseExpiresAt).toBeNull();
});

test('a mid-run reconnect skips the health write and flags the caller (codex, PR #142)', async () => {
	// The finally update matched only the channel id: a reconnect replacing
	// refreshTokenEnc mid-run would stamp the NEW connector with the OLD
	// run's verdict. The write is guarded by connector identity like
	// assertChannelActive — zero rows matched means loud log + flag.
	await seedChannel('UC-race', { lastRunStatus: 'success', lastSuccessAt: '2026-08-01T00:00:00.000Z' });
	mocks.runChannel.mockImplementation(async () => {
		await testDb().db.update(channels).set({ refreshTokenEnc: 'rotated' }).where(eq(channels.id, 'UC-race'));
		return runResult({ dryRun: false });
	});
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const res = await call({ bearer: 'test-secret' });

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ bookkeepingError: true });
		const row = await channelRow('UC-race');
		expect(row?.refreshTokenEnc).toBe('rotated');
		expect(row?.lastRunStatus).toBe('success'); // untouched — the verdict belongs to the old connector
		expect(row?.lastSuccessAt).toBe('2026-08-01T00:00:00.000Z');
	} finally {
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
		expect(body.ok).toBe(false); // a failed sweep must not tick as success (codeant)
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

test('an invalid DRY_RUN fails loudly at the entry — no sweep runs live', async () => {
	// 'yes' is not 'true': without the entry check the retention sweeps would
	// have run with dryRun=false and erased real data.
	mocks.env.DRY_RUN = 'yes';
	const oldDate = new Date(Date.now() - CONSENT_EMAIL_RETENTION_MS - DAY_MS).toISOString();
	await seedConsent('old', oldDate);
	await seedChannel('UC-live');

	await expect(call({ bearer: 'test-secret' })).rejects.toMatchObject({ status: 500 });
	expect(mocks.runChannel).not.toHaveBeenCalled();
	expect(mocks.retryStripeCustomerDeletions).not.toHaveBeenCalled();
	// Nothing durable happened — the expired consent e-mail is still there.
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

test('erases commenter handles older than 30 days from both handle-bearing tables, keeping the rows', async () => {
	mocks.env.DRY_RUN = 'false';
	const oldDate = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	const recentDate = new Date(Date.now() - DAY_MS).toISOString();
	await seedHandledAuditRow('old', oldDate);
	await seedHandledAuditRow('recent', recentDate);
	await seedHandledActionRow('action-old', oldDate);
	await seedHandledActionRow('action-recent', recentDate);

	const res = await call({ bearer: 'test-secret' });

	// The response reports each table's erased count separately.
	expect(await res.json()).toMatchObject({ ok: true, auditHandlesNulled: 1, actionHandlesNulled: 1 });
	const rows = await testDb().db.select().from(auditLog).all();
	expect(rows).toHaveLength(2);
	// The ROW is kept (action, reason, timestamps) — only the identifier goes.
	expect(rows.find((row) => row.commentId === 'old')).toMatchObject({ authorHandle: null, action: 'reject' });
	expect(rows.find((row) => row.commentId === 'recent')).toMatchObject({ authorHandle: '@some.user' });
	const actions = await testDb().db.select().from(moderationActions).all();
	expect(actions).toHaveLength(2);
	expect(actions.find((row) => row.commentId === 'action-old')).toMatchObject({ authorHandle: null, action: 'ban' });
	expect(actions.find((row) => row.commentId === 'action-recent')).toMatchObject({ authorHandle: '@some.user' });
});

test('a handle sweep failure is reported and does not stop the channel run', async () => {
	mocks.env.DRY_RUN = 'false';
	const oldDate = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	await seedHandledAuditRow('old', oldDate);
	await seedHandledActionRow('action-old', oldDate);
	await seedChannel('UC-live');
	mocks.runChannel.mockResolvedValue({ fetched: 0, acted: 0, queued: 0, partial: false, skipped: false, dryRun: false });
	await testDb().client.execute(
		`CREATE TRIGGER fail_audit_handle_update BEFORE UPDATE ON audit_log
		 BEGIN SELECT RAISE(ABORT, 'simulated handle sweep failure'); END`
	);
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const res = await call({ bearer: 'test-secret' });

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.handleSweepError).toEqual(expect.stringContaining('Failed query'));
		expect(body.auditHandlesNulled).toBe(0);
		expect(body.actionHandlesNulled).toBe(0);
		expect(mocks.runChannel).toHaveBeenCalledWith('UC-live', expect.objectContaining({ deadline: expect.any(Number) }));
		// The sweep failure is logged loudly.
		expect(errorSpy).toHaveBeenCalledWith('commenter-handle retention sweep failed:', expect.any(Error));
	} finally {
		errorSpy.mockRestore();
		await testDb().client.execute('DROP TRIGGER fail_audit_handle_update');
	}

	// The failed sweep changed nothing, so the next invocation retries it.
	expect((await testDb().db.select().from(auditLog).all())[0].authorHandle).toBe('@some.user');
	expect((await testDb().db.select().from(moderationActions).all())[0].authorHandle).toBe('@some.user');
});

test('a dry run skips the commenter-handle sweep entirely (I8)', async () => {
	const oldDate = new Date(Date.now() - AUDIT_HANDLE_RETENTION_MS - DAY_MS).toISOString();
	await seedHandledAuditRow('old', oldDate);
	await seedHandledActionRow('action-old', oldDate);
	// The skipped sweep is announced loudly.
	const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

	try {
		const res = await call({ bearer: 'test-secret' });

		expect(await res.json()).toMatchObject({ ok: true, dryRun: true, auditHandlesNulled: 0, actionHandlesNulled: 0 });
		expect(infoSpy).toHaveBeenCalledWith('dry run: commenter-handle retention sweep skipped');
	} finally {
		infoSpy.mockRestore();
	}
	expect((await testDb().db.select().from(auditLog).all())[0].authorHandle).toBe('@some.user');
	expect((await testDb().db.select().from(moderationActions).all())[0].authorHandle).toBe('@some.user');
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
	// Boundary stays until the window completes; only the token advances.
	expectDrainState(await channelRow('UC1'), '2026-05-01T00:00:00.000Z', 'tok-2');
});

test('clears the drain state when the dry-run window completes', async () => {
	await seedDrainChannel('UC1', 'tok-9');
	mocks.runChannel
		.mockResolvedValueOnce(runResult())
		.mockResolvedValueOnce(runResult({ fetched: 40, acted: 1, windowComplete: true, windowNextPageToken: null }));

	await call({ bearer: 'test-secret' });

	expectDrainState(await channelRow('UC1'), null, null);
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
	const body = await res.json();
	expect(body).toMatchObject({ ok: true, results: { UC1: normal } });
	expect(body.dryRunWindow).toEqual({ error: 'drain exploded' });
	// Exact message: an emptied or altered log line must fail this test.
	expect(spy).toHaveBeenCalledWith('dry-run window drain failed for channel:', 'UC1', expect.any(Error));
	// The drain state is untouched so the next invocation retries it.
	expectDrainState(await channelRow('UC1'), '2026-05-01T00:00:00.000Z', 'tok-1');
});

test('a channel without a drain runs once and reports no window work', async () => {
	await seedChannel('UC1');
	mocks.runChannel.mockResolvedValue(runResult());

	const res = await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).toHaveBeenCalledTimes(1);
	const body = await res.json();
	expect(body.dryRunWindow).toBeUndefined();
});

test.each([
	{ phase: 'completing', drain: { windowComplete: true, windowNextPageToken: null } },
	{ phase: 'continuation write', drain: { windowComplete: false, windowNextPageToken: 'tok-2' } }
])('a preview replanted mid-invocation survives a stale drain $phase', async ({ drain }) => {
	// Cron reads the channel row BEFORE the atomic claim; a dashboard preview
	// can claim, replant a NEW window, and release in between. Neither drain
	// write may touch the replacement state (the boundary predicate no-ops).
	await seedDrainChannel('UC1', 'tok-1');
	mocks.runChannel
		.mockResolvedValueOnce(runResult({ fetched: 1 }))
		.mockImplementationOnce(async () => {
			await testDb()
				.db.update(channels)
				.set({ dryRunBoundary: '2026-06-01T00:00:00.000Z', dryRunPageToken: 'fresh-token' })
				.where(eq(channels.id, 'UC1'));
			return runResult(drain);
		});

	await call({ bearer: 'test-secret' });

	expectDrainState(await channelRow('UC1'), '2026-06-01T00:00:00.000Z', 'fresh-token');
});
