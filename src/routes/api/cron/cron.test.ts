import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DAY_MS, seedConsent as seedConsentRecord, seedUser, setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, consents, feedbackDigests, moderationActions } from '$lib/server/db/schema';
import { AUDIT_HANDLE_RETENTION_MS, CONSENT_EMAIL_RETENTION_MS } from '$lib/server/deletion';
import { DeadlineExceededError } from '$lib/server/http';

// Synthetic credential fixture — same maintainer-approved exception as
// netlify/cron.test.mjs (2026-07-30, PR #13 review, per AGENTS.md).
const mocks = vi.hoisted(() => ({
	env: { CRON_SECRET: 'test-secret', DRY_RUN: 'true' } as Record<string, string | undefined>,
	runChannel: vi.fn(),
	generateFeedbackDigest: vi.fn(),
	retryContactNotifications: vi.fn(async (_deadline: number) => ({ sent: 0, errors: 0 })),
	runFeedbackPreview: vi.fn(),
	retryStripeCustomerDeletions: vi.fn(async (_limit: number, _deadline: number) => 0),
	sweepZeroCreditAccounts: vi.fn(async (_limit: number, _deadline: number) => ({ evaluated: 0, warned: 0, deleted: 0, errors: 0 }))
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/contactNotification', () => ({ retryContactNotifications: mocks.retryContactNotifications }));
vi.mock('$lib/server/pipeline', () => ({ runChannel: mocks.runChannel }));
vi.mock('$lib/server/feedbackDigest', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/feedbackDigest')>();
	return { ...actual, generateFeedbackDigest: mocks.generateFeedbackDigest, runFeedbackPreview: mocks.runFeedbackPreview };
});
vi.mock('$lib/server/deletion', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/deletion')>();
	// Spy on just the outbox retry (the other deletion sweeps stay real) so a
	// test can pin the shared deadline the route hands it.
	return { ...actual, retryStripeCustomerDeletions: mocks.retryStripeCustomerDeletions };
});
vi.mock('$lib/server/zeroCredits', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/zeroCredits')>();
	// The sweep itself is unit-tested in zeroCredits.test.ts; here the mock
	// pins the cron wiring (deadline hand-off, payload fields, error surfacing).
	return { ...actual, sweepZeroCreditAccounts: mocks.sweepZeroCreditAccounts };
});

import { GET } from './+server';

setupTestDb(['channels', 'users', 'consents', 'audit_log', 'moderation_actions', 'feedback_digests']);

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
	mocks.generateFeedbackDigest.mockResolvedValue({ status: 'skipped', reason: 'disabled' });
	mocks.runFeedbackPreview.mockResolvedValue({ commentsClassified: 0, commentsFailed: 0, pooled: 0, hasMore: false, findings: [] });
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
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

	try {
		await expectUnauthorized();
		expect(warnSpy).toHaveBeenCalledWith('cron: rejected request — no credentials');
	} finally {
		warnSpy.mockRestore();
	}
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

test('the zero-credit sweep shares the cron deadline and reports its counts', async () => {
	mocks.env.DRY_RUN = 'false';
	mocks.sweepZeroCreditAccounts.mockClear();
	mocks.sweepZeroCreditAccounts.mockResolvedValueOnce({ evaluated: 12, warned: 3, deleted: 1, errors: 2 });

	const res = await call({ query: 'test-secret' });

	expect(mocks.sweepZeroCreditAccounts).toHaveBeenCalledTimes(1);
	const [limit, deadline] = mocks.sweepZeroCreditAccounts.mock.calls[0] as [number, number];
	expect(limit).toBe(25);
	expect(typeof deadline).toBe('number');
	expect(deadline).toBeGreaterThan(Date.now() - 30_000);
	expect(await res.json()).toMatchObject({
		// codeant: per-account eval failures must mark the tick failed —
		// an ok:true response lets a permanently throwing evaluation retry
		// forever, invisible to every scheduler.
		ok: false,
		zeroCreditAccountsChecked: 12,
		zeroCreditWarningsSent: 3,
		zeroCreditAccountsDeleted: 1,
		zeroCreditItemErrors: 2,
		zeroCreditSweepError: null
	});
});

test('a dry run skips the zero-credit account sweep entirely (I8)', async () => {
	// The skipped sweep is announced loudly — same guarantee as the consent
	// and handle sweeps: DRY_RUN must never stamp, warn, or delete accounts.
	const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
	try {
		const res = await call({ bearer: 'test-secret' });

		expect(await res.json()).toMatchObject({
			ok: true,
			dryRun: true,
			zeroCreditAccountsChecked: 0,
			zeroCreditWarningsSent: 0,
			zeroCreditAccountsDeleted: 0
		});
		expect(infoSpy).toHaveBeenCalledWith('dry run: zero-credit account sweep skipped');
	} finally {
		infoSpy.mockRestore();
	}
	expect(mocks.sweepZeroCreditAccounts).not.toHaveBeenCalled();
});

test('a zero-credit sweep failure surfaces in the payload without stopping moderation', async () => {
	mocks.env.DRY_RUN = 'false';
	mocks.sweepZeroCreditAccounts.mockRejectedValueOnce(new Error('db exploded'));
	await seedChannel('UC1');
	mocks.runChannel.mockResolvedValue(runResult());
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		const res = await call({ bearer: 'test-secret' });
		expect(await res.json()).toMatchObject({ ok: false, zeroCreditSweepError: 'db exploded' });
		// The sweep threw but the channel still ran — retention must never
		// starve scheduled moderation.
		expect(mocks.runChannel).toHaveBeenCalledWith('UC1', expect.anything());
	} finally {
		errorSpy.mockRestore();
	}
});

test('rejects a wrong secret in both query and header without logging the provided value', async () => {
	const providedSecret = 'never-log-this-secret-value';
	const consoleSpies = [
		vi.spyOn(console, 'info').mockImplementation(() => {}),
		vi.spyOn(console, 'warn').mockImplementation(() => {}),
		vi.spyOn(console, 'error').mockImplementation(() => {})
	];

	try {
		await expectUnauthorized({ query: 'wrong' });
		await expectUnauthorized({ bearer: providedSecret });

		expect(consoleSpies[1]).toHaveBeenCalledWith('cron: rejected request — secret mismatch');
		const loggedArguments = consoleSpies.flatMap((spy) => spy.mock.calls.flat().map(String));
		expect(loggedArguments.join(' ')).not.toContain(providedSecret);
	} finally {
		consoleSpies.forEach((spy) => spy.mockRestore());
	}
});

test('rejects length-mismatched secrets without throwing a 500', async () => {
	await expectUnauthorized({ bearer: 'x' });
	await expectUnauthorized({ bearer: 'test-secret-but-longer' });
	await expectUnauthorized({ bearer: 'test-secrex' });
});

test('fails loudly when CRON_SECRET is not configured', async () => {
	delete mocks.env.CRON_SECRET;
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		// Exact message: an emptied message stayed green in the mutation audit —
		// "fail loudly" means a clear message, not just any 500.
		await expect(call({ bearer: 'anything' })).rejects.toMatchObject({
			status: 500,
			body: { message: 'CRON_SECRET is not configured' }
		});
		expect(errorSpy).toHaveBeenCalledWith('cron: CRON_SECRET is not configured');
	} finally {
		errorSpy.mockRestore();
	}
});

test('rejects a malformed Authorization header even with a valid query secret', async () => {
	const url = new URL('http://localhost/api/cron?secret=test-secret');
	const request = new Request(url, { headers: { authorization: 'Basic anything' } });
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

	try {
		await expect(GET({ url, request } as never)).rejects.toMatchObject({
			status: 401,
			body: { message: 'bad secret' }
		});
		expect(warnSpy).toHaveBeenCalledWith('cron: rejected request — malformed Authorization header');
	} finally {
		warnSpy.mockRestore();
	}
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

test('logs when there is no active, unleased channel to run', async () => {
	const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

	try {
		await call({ bearer: 'test-secret' });
		expect(infoSpy).toHaveBeenCalledWith('cron: no active, unleased channel to run');
	} finally {
		infoSpy.mockRestore();
	}
});

test('logs the claimed channel id and resume state', async () => {
	await seedChannel('UC-claimed');
	mocks.runChannel.mockResolvedValue(runResult());
	const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

	try {
		await call({ bearer: 'test-secret' });
		expect(infoSpy).toHaveBeenCalledWith(
			'cron: claimed channel UC-claimed (lastRunAt=never, cursor=none, resumingPage=false, dryRunDrain=false)'
		);
		expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/^cron: channel UC-claimed finished in \d+ms — health=none$/));
	} finally {
		infoSpy.mockRestore();
	}
});

test('reports when sweeps consume the run budget and marks the payload exhausted', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(1_000));
	const infoSpy = vi.spyOn(console, 'info').mockImplementation((message) => {
		if (message === 'dry run: consent e-mail retention sweep skipped') vi.setSystemTime(new Date(21_025));
	});
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		const response = await call({ bearer: 'test-secret' });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, budgetExhausted: true, results: {} });
		expect(errorSpy).toHaveBeenCalledWith(
			'cron: sweeps consumed the 20000ms run budget (20025ms) — no channel claimed this tick'
		);
	} finally {
		infoSpy.mockRestore();
		errorSpy.mockRestore();
		vi.useRealTimers();
	}
});

test('runs the channel with a server-side deadline inside the caller abort window', async () => {
	await seedChannel('UC1');
	const before = Date.now();

	await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).toHaveBeenCalledWith('UC1', expect.objectContaining({
		// The scheduled function aborts at 25s; the server must stop before that.
		deadline: expect.any(Number),
		maxPages: 1
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
	const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
	try {
		const res = await call({ bearer: 'test-secret' });

		expect(await res.json()).toMatchObject({ ok: true, claimed: false, results: {} });
		expect(mocks.runChannel).not.toHaveBeenCalled();
		expect(infoSpy).toHaveBeenCalledWith('cron: lost claim race for channel UC-race');
	} finally {
		infoSpy.mockRestore();
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

test('a channel with an unfinished history scan waits its least-recently-run turn', async () => {
	// History work must never outrank the rotation: a stuck or multi-page job
	// would otherwise claim every invocation and starve live moderation.
	mocks.env.DRY_RUN = 'false';
	await seedChannel('UC-old', { lastRunAt: '2026-01-01T00:00:00.000Z' });
	await seedChannel('UC-history', { feedbackEnabled: 1, lastRunAt: '2026-09-01T00:00:00.000Z', feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z' });
	mocks.runChannel.mockResolvedValue(runResult());

	await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).toHaveBeenCalledWith('UC-old', expect.anything());
	expect(mocks.runChannel).not.toHaveBeenCalledWith('UC-history', expect.anything());
});

test('disabled history does not starve an older channel or claim first-position priority', async () => {
	mocks.env.DRY_RUN = 'false';
	await seedChannel('UC-older', { lastRunAt: '2026-01-01T00:00:00.000Z' });
	await seedChannel('UC-disabled-history', { active: 1, feedbackEnabled: 0, lastRunAt: '2026-09-01T00:00:00.000Z', feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z' });
	mocks.runChannel.mockResolvedValue(runResult());

	await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).toHaveBeenCalledWith('UC-older', expect.anything());
	expect(mocks.runChannel).not.toHaveBeenCalledWith('UC-disabled-history', expect.anything());
	expect((await channelRow('UC-disabled-history'))?.feedbackHistoryBoundary).toBe('2025-01-01T00:00:00.000Z');
});

test('history feedback runs after moderation and is not attempted twice in the same tick', async () => {
	// The history page shares the claimed channel's leftover budget: a fetch
	// that overruns defers cleanly instead of pushing live moderation past
	// the deadline (codex+cubic).
	mocks.env.DRY_RUN = 'false';
	await seedChannel('UC-history', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z' });
	const order: string[] = [];
	mocks.generateFeedbackDigest.mockImplementationOnce(async () => {
		order.push('feedback');
		return { status: 'complete', historyRemaining: true };
	});
	mocks.runChannel.mockImplementationOnce(async () => {
		order.push('moderation');
		return runResult();
	});

	await call({ bearer: 'test-secret' });

	expect(order).toEqual(['moderation', 'feedback']);
	expect(mocks.generateFeedbackDigest).toHaveBeenCalledTimes(1);
});

test('history digest failure does not prevent moderation or trigger a second digest attempt in the same tick', async () => {
	mocks.env.DRY_RUN = 'false';
	await seedChannel('UC-history', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z' });
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	mocks.generateFeedbackDigest.mockRejectedValueOnce(new Error('raw feedback failure'));
	mocks.runChannel.mockResolvedValueOnce(runResult());

	try {
		const response = await call({ bearer: 'test-secret' });
		expect(response.status).toBe(200);
		expect(mocks.runChannel).toHaveBeenCalledTimes(1);
		expect(mocks.generateFeedbackDigest).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith('feedback digest failed for channel:', 'UC-history', expect.any(Error));
		const body = await response.json();
		expect(JSON.stringify(body)).not.toContain('raw feedback failure');
	} finally {
		errorSpy.mockRestore();
	}
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
		expect(errorSpy).toHaveBeenCalledWith('channel run %s failed:', 'UC-bad', expect.any(Error));
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
	// YouTube moderation write failures are provider errors, not AI scoring
	// failures — the word "moderation" alone must not win.
	{ label: 'moderation write', message: 'setModerationStatus failed: 500 Internal Server Error', category: 'error' }
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
		expect(errorSpy).toHaveBeenCalledWith('%s failed:', 'consent e-mail retention sweep', expect.any(Error));
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
		expect(errorSpy).toHaveBeenCalledWith('%s failed:', 'commenter-handle retention sweep', expect.any(Error));
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

test('a channel with a drain in flight waits for older ordinary channels', async () => {
	// A pending preview shares the live rotation; it must not monopolize cron.
	await seedChannel('UC-old', { lastRunAt: '2026-01-01T00:00:00.000Z' });
	await seedDrainChannel('UC-drain', null, { lastRunAt: '2026-08-01T00:00:00.000Z' });
	mocks.runChannel.mockResolvedValue(runResult({ windowComplete: true, windowNextPageToken: null }));

	await call({ bearer: 'test-secret' });

	expect(mocks.runChannel.mock.calls[0][0]).toBe('UC-old');
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


test('contact notification retry shares the deadline and reports deliveries and failures', async () => {
	mocks.env.DRY_RUN = 'false';
	mocks.retryContactNotifications.mockResolvedValueOnce({ sent: 1, errors: 1 });
	const response = await call({ query: 'test-secret' });
	const body = await response.json();
	expect(mocks.retryContactNotifications).toHaveBeenCalledTimes(1);
	const [deadline] = mocks.retryContactNotifications.mock.calls[0];
	expect(deadline).toBeGreaterThan(Date.now() - 30_000);
	expect(body).toMatchObject({ ok: false, contactNotificationsSent: 1, contactNotificationErrors: 1 });
});

test('dry runs never send or claim contact notifications', async () => {
	const response = await call({ query: 'test-secret' });
	expect(mocks.retryContactNotifications).not.toHaveBeenCalled();
	expect(await response.json()).toMatchObject({ contactNotificationsSent: 0, contactNotificationErrors: 0 });
});

test('contact notification database failure is surfaced without stopping the other sweeps', async () => {
	mocks.env.DRY_RUN = 'false';
	mocks.retryContactNotifications.mockRejectedValueOnce(new Error('database unavailable'));
	const response = await call({ query: 'test-secret' });
	expect(await response.json()).toMatchObject({ ok: false, contactNotificationSweepError: 'database unavailable' });
	expect(mocks.sweepZeroCreditAccounts).toHaveBeenCalled();
});

/** Seeds a planted feedback preview row; `plantAge`/`attemptedAge` backdate the plant/first-claim stamps. */
async function seedPendingPreview(channelId: string, opts: { boundary?: string; plantAge?: number; attemptedAge?: number } = {}) {
	const planted = new Date(Date.now() - (opts.plantAge ?? 0)).toISOString();
	const attemptedAt = opts.attemptedAge === undefined ? null : new Date(Date.now() - opts.attemptedAge).toISOString();
	const [row] = await testDb()
		.db.insert(feedbackDigests)
		.values({
			channelId,
			windowStart: opts.boundary ?? '2026-05-01T00:00:00.000Z',
			windowEnd: planted,
			attemptedAt,
			status: 'dry-run-pending'
		})
		.returning({ id: feedbackDigests.id });
	return row.id;
}

test('drains the oldest pending feedback preview under a fresh lease — the rotation waits a tick', async () => {
	await seedChannel('UC-prev');
	const digestId = await seedPendingPreview('UC-prev');
	const preview = {
		commentsClassified: 2,
		commentsFailed: 0,
		pooled: 0,
		hasMore: false,
		findings: [
			{
				category: 'question',
				summary: 'marker-summary-xyz',
				supporterCount: 1,
				evidence: [{ sanitizedExcerpt: 'marker-excerpt-abc', hasAbuse: 0 }]
			}
		]
	};
	// Capture the live lease mid-run: the claim fingerprint the drainer hands
	// the runner must be the lease it stamped (cubic, PR #178).
	let leaseDuringRun: string | null = null;
	mocks.runFeedbackPreview.mockImplementation(async () => {
		leaseDuringRun = (await channelRow('UC-prev'))?.leaseExpiresAt ?? null;
		return preview;
	});
	mocks.runChannel.mockResolvedValue(runResult());

	const res = await call({ bearer: 'test-secret' });

	// The pending row is the resume record: the drainer hands the runner the
	// row's pinned windowStart as the boundary, not a recomputed one — and
	// binds the run to the claimed fingerprint so a reconnect mid-queue
	// aborts instead of executing on the wrong org (cubic).
	expect(leaseDuringRun).toBeTruthy();
	expect(mocks.runFeedbackPreview).toHaveBeenCalledWith('UC-prev', digestId, {
		boundary: '2026-05-01T00:00:00.000Z',
		deadline: expect.any(Number),
		claim: { orgId: null, refreshTokenEnc: 'enc', leaseExpiresAt: leaseDuringRun }
	});
	const body = await res.json();
	// Operational counts only: `findings` carry near-verbatim commenter
	// excerpts persisted for the feed — the scheduler drivers log this
	// response, so evidence must never cross the cron boundary (codex).
	expect(body).toMatchObject({
		ok: true,
		feedbackPreview: { commentsClassified: 2, commentsFailed: 0, pooled: 0, hasMore: false },
		results: {}
	});
	expect(body.feedbackPreview).not.toHaveProperty('findings');
	expect(JSON.stringify(body)).not.toContain('marker-excerpt-abc');
	expect(JSON.stringify(body)).not.toContain('marker-summary-xyz');
	// The drainer's lease is released after the run.
	expect((await channelRow('UC-prev'))?.leaseExpiresAt).toBeNull();
	// One claimed workload per invocation (I10): the drained preview IS this
	// tick's channel work — a rotation claim would inherit a spent deadline
	// and log a fake timeout for a channel never moderated (gitar+cubic+codex).
	expect(mocks.runChannel).not.toHaveBeenCalled();
});

test('a pending preview on a leased channel is not drained — the plant lease covers its window', async () => {
	// The dryRun action leaves the claim's 60s lease on the channel; the
	// kicked runner (or that lease's expiry) owns it — the drainer must wait
	// rather than run the same channel concurrently.
	await seedChannel('UC-leased', { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
	await seedPendingPreview('UC-leased');
	mocks.runChannel.mockResolvedValue(runResult());

	await call({ bearer: 'test-secret' });

	expect(mocks.runFeedbackPreview).not.toHaveBeenCalled();
	expect((await testDb().db.select().from(feedbackDigests).all())[0].status).toBe('dry-run-pending');
});

test('a pending preview on a paused channel is never drained and finalizes — it has no opportunity', async () => {
	// Paused channels are un-drainable by definition (the pending select
	// requires active=1) — and the kicked runner would fail
	// ERR_PREVIEW_PAUSED anyway — so a pending row there is a corpse, not a
	// queue. Leaving it pending would show 'preview in progress' forever
	// (codex review, PR #178).
	await seedChannel('UC-paused', { active: 0 });
	await seedPendingPreview('UC-paused');
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => errorSpy.mockRestore());

	await call({ bearer: 'test-secret' });

	expect(mocks.runFeedbackPreview).not.toHaveBeenCalled();
	expect((await testDb().db.select().from(feedbackDigests).all())[0]).toMatchObject({
		status: 'dry-run-failed',
		error: 'preview-timeout'
	});
});

test('a pending preview older than the stale window is finalized loudly, not retried forever', async () => {
	// A crashed runner leaves the row pending; past PREVIEW_PENDING_STALE_MS
	// since its first drain attempt means a dead run — finalizing
	// 'dry-run-failed' keeps it out of transient digest state and tells the
	// user it died (I3 audit trail). Plant age alone is NOT the signal — a
	// queued row that never got a scheduler opportunity must not expire
	// (codex, PR #178).
	await seedChannel('UC-stale');
	await seedPendingPreview('UC-stale', { plantAge: 22 * 60 * 1000, attemptedAge: 21 * 60 * 1000 });
	mocks.runChannel.mockResolvedValue(runResult());
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => errorSpy.mockRestore());

	const res = await call({ bearer: 'test-secret' });

	expect(mocks.runFeedbackPreview).not.toHaveBeenCalled();
	const row = (await testDb().db.select().from(feedbackDigests).all())[0];
	expect(row).toMatchObject({ status: 'dry-run-failed', error: 'preview-timeout' });
	expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('UC-stale'));
	expect((await res.json()).feedbackPreview).toMatchObject({ staleFailed: 1 });
	// The rotation is unaffected.
	expect(mocks.runChannel).toHaveBeenCalledWith('UC-stale', expect.objectContaining({ maxPages: 1 }));
});

test('a deadline-aborted preview stays pending for the next tick and releases the lease', async () => {
	// DeadlineExceededError is the one non-terminal outcome — the row must
	// remain 'dry-run-pending' so a later tick (or the next deployment)
	// resumes it (I3).
	await seedChannel('UC-slow');
	await seedPendingPreview('UC-slow');
	mocks.runFeedbackPreview.mockRejectedValue(new DeadlineExceededError());
	mocks.runChannel.mockResolvedValue(runResult());
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => errorSpy.mockRestore());

	const res = await call({ bearer: 'test-secret' });

	const abortedRow = (await testDb().db.select().from(feedbackDigests).all())[0];
	expect(abortedRow.status).toBe('dry-run-pending');
	// The claim stamped the first-attempt marker — the stale window measures
	// from it, so the abort still resumes next tick instead of expiring.
	expect(abortedRow.attemptedAt).toBeTruthy();
	expect((await channelRow('UC-slow'))?.leaseExpiresAt).toBeNull();
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.feedbackPreview).toMatchObject({ error: 'timeout' });
	expect(body.results).toEqual({});
	// The drain consumed the budget — the rotation must not inherit the spent
	// deadline and record a fake timeout for a channel never run (gitar+cubic).
	expect(mocks.runChannel).not.toHaveBeenCalled();
});

test('a failed preview drain is surfaced and ends the tick — the rotation defers (I10)', async () => {
	await seedChannel('UC-fail');
	await seedPendingPreview('UC-fail');
	mocks.runFeedbackPreview.mockRejectedValue(new Error('provider exploded — token-xyz'));
	mocks.runChannel.mockResolvedValue(runResult());
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => errorSpy.mockRestore());

	const res = await call({ bearer: 'test-secret' });

	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body).toMatchObject({ ok: true, results: {} });
	// Only the sanitized category reaches the payload — provider error bodies
	// can echo request detail and must never reach the caller (codeant).
	expect(body.feedbackPreview).toEqual({ error: 'error' });
	expect(JSON.stringify(body)).not.toContain('token-xyz');
	// Moderation is deferred, not masked: no claim, no run, no bookkeeping —
	// the channel keeps its rotation place for the next tick.
	expect(mocks.runChannel).not.toHaveBeenCalled();
	expect((await channelRow('UC-fail'))?.lastRunAt).toBeNull();
	expect((await channelRow('UC-fail'))?.lastRunStatus).toBeNull();
});

test('the drain is bounded: only the oldest pending preview runs per tick (I10)', async () => {
	await seedChannel('UC-a');
	await seedChannel('UC-b');
	const oldest = await seedPendingPreview('UC-b');
	await seedPendingPreview('UC-a');
	mocks.runFeedbackPreview.mockResolvedValue({ commentsClassified: 0, commentsFailed: 0, pooled: 0, hasMore: false, findings: [] });

	await call({ bearer: 'test-secret' });

	expect(mocks.runFeedbackPreview).toHaveBeenCalledTimes(1);
	expect(mocks.runFeedbackPreview).toHaveBeenCalledWith('UC-b', oldest, expect.objectContaining({ boundary: '2026-05-01T00:00:00.000Z' }));
});

test('a stale pending row on a leased channel is NOT finalized — a live runner may own it', async () => {
	// A drainer that claimed the channel just before the 10-minute mark holds
	// a live lease while the row ages past it; finalizing now would flip a
	// mid-flight preview to a false 'preview-timeout' — and the runner's
	// guarded completion then fails on a row that was never dead
	// (cubic+codex, PR #178).
	await seedChannel('UC-leased', { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
	const digestId = await seedPendingPreview('UC-leased', { plantAge: 22 * 60 * 1000, attemptedAge: 21 * 60 * 1000 });

	await call({ bearer: 'test-secret' });

	expect(mocks.runFeedbackPreview).not.toHaveBeenCalled();
	expect(
		(await testDb().db.select().from(feedbackDigests).where(eq(feedbackDigests.id, digestId)).get())?.status
	).toBe('dry-run-pending');
});

test('a stale pending row on a PAUSED channel under a live lease still survives', async () => {
	// The lease guard is hoisted above the un-drainable clause: a channel
	// paused while a runner still holds its 60s claim lease must not have
	// its preview finalized out from under the run — finalizing waits one
	// sweep for the lease to expire (coderabbit+cubic, PR #181).
	await seedChannel('UC-paused-leased', { active: 0, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
	const digestId = await seedPendingPreview('UC-paused-leased', { plantAge: 22 * 60 * 1000, attemptedAge: 21 * 60 * 1000 });

	await call({ bearer: 'test-secret' });

	expect(mocks.runFeedbackPreview).not.toHaveBeenCalled();
	expect(
		(await testDb().db.select().from(feedbackDigests).where(eq(feedbackDigests.id, digestId)).get())?.status
	).toBe('dry-run-pending');
});

test('a stale pending row whose channel lease expired still finalizes', async () => {
	await seedChannel('UC-exp', { leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
	const digestId = await seedPendingPreview('UC-exp', { plantAge: 22 * 60 * 1000, attemptedAge: 21 * 60 * 1000 });
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => errorSpy.mockRestore());

	await call({ bearer: 'test-secret' });

	expect(
		(await testDb().db.select().from(feedbackDigests).where(eq(feedbackDigests.id, digestId)).get())
	).toMatchObject({ status: 'dry-run-failed', error: 'preview-timeout' });
});

test('a stale pending row on a deleted channel still finalizes', async () => {
	// channel_id is plain text (no FK) — a deleted channel's leftover must
	// still age out or it pins the pending state forever.
	const digestId = await seedPendingPreview('UC-gone', { plantAge: 11 * 60 * 1000 });
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => errorSpy.mockRestore());

	await call({ bearer: 'test-secret' });

	expect(
		(await testDb().db.select().from(feedbackDigests).where(eq(feedbackDigests.id, digestId)).get())
	).toMatchObject({ status: 'dry-run-failed', error: 'preview-timeout' });
});

test('the stale sweep is bounded — an outage backlog finalizes across ticks', async () => {
	// A deployment freeze can leave a backlog of dead pending rows; the sweep
	// caps per tick so the finalize+log work stays proportional to the bound,
	// not the whole backlog (codex, PR #178).
	await seedChannel('UC-stale');
	for (let i = 0; i < 30; i++) await seedPendingPreview('UC-stale', { plantAge: 22 * 60 * 1000, attemptedAge: 21 * 60 * 1000 });
	mocks.runFeedbackPreview.mockResolvedValue({ commentsClassified: 0, commentsFailed: 0, pooled: 0, hasMore: false, findings: [] });
	mocks.runChannel.mockResolvedValue(runResult());
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => errorSpy.mockRestore());

	const res = await call({ bearer: 'test-secret' });

	const rows = await testDb().db.select().from(feedbackDigests).all();
	expect(rows.filter((r) => r.status === 'dry-run-failed')).toHaveLength(25);
	// The leftovers are stale — dead rows belong to the sweep, which reaches
	// them on later ticks; the drainer must never run one as a live preview
	// (codex, PR #178).
	expect(rows.filter((r) => r.status === 'dry-run-pending')).toHaveLength(5);
	expect(mocks.runFeedbackPreview).not.toHaveBeenCalled();
	expect((await res.json()).feedbackPreview).toMatchObject({ staleFailed: 25 });
	// With no live preview drained, the tick's workload is the rotation run.
	expect(mocks.runChannel).toHaveBeenCalledWith('UC-stale', expect.objectContaining({ maxPages: 1 }));
});

test('a never-attempted pending row drains regardless of plant age — queue age is not a crash signal', async () => {
	// The stale window expires only rows that had a real drain opportunity:
	// a burst queue or the documented */15 schedule can leave a planted row
	// unclaimed past PREVIEW_PENDING_STALE_MS through no fault of a runner —
	// expiring it would burn the user's one-time preview without ever
	// running it (codex, PR #178).
	await seedChannel('UC-queued');
	const digestId = await seedPendingPreview('UC-queued', { plantAge: 30 * 60 * 1000 });
	mocks.runFeedbackPreview.mockResolvedValue({ commentsClassified: 1, commentsFailed: 0, pooled: 0, hasMore: false, findings: [] });

	const res = await call({ bearer: 'test-secret' });

	expect(mocks.runFeedbackPreview).toHaveBeenCalledWith(
		'UC-queued',
		digestId,
		expect.objectContaining({ boundary: '2026-05-01T00:00:00.000Z' })
	);
	expect((await res.json()).feedbackPreview).toMatchObject({ commentsClassified: 1 });
});

test('a deadline-aborted preview re-drains while its first attempt is still inside the window', async () => {
	// The attempt anchor is the FIRST claim: a pending row aborted by the
	// deadline stays drainable inside the stale window (I3 resume), while a
	// poison row still dies ~PREVIEW_PENDING_STALE_MS after first attempt.
	await seedChannel('UC-retry');
	const digestId = await seedPendingPreview('UC-retry', { plantAge: 6 * 60 * 1000, attemptedAge: 5 * 60 * 1000 });
	mocks.runFeedbackPreview.mockResolvedValue({ commentsClassified: 1, commentsFailed: 0, pooled: 0, hasMore: false, findings: [] });

	await call({ bearer: 'test-secret' });

	expect(mocks.runFeedbackPreview).toHaveBeenCalledWith('UC-retry', digestId, expect.anything());
});

test('a deadline-aborted preview still gets its retry tick on the documented */15 cadence', async () => {
	// The production schedule is */15: an attempt that deadline-aborts at T
	// meets its next tick at T+15min. The stale window must exceed the
	// longest documented interval or the sweep finalizes the row before the
	// retry ever runs — one transient timeout would spend the channel's
	// one-time preview (codex, PR #178).
	await seedChannel('UC-quarter');
	const digestId = await seedPendingPreview('UC-quarter', { plantAge: 17 * 60 * 1000, attemptedAge: 16 * 60 * 1000 });
	mocks.runFeedbackPreview.mockResolvedValue({ commentsClassified: 1, commentsFailed: 0, pooled: 0, hasMore: false, findings: [] });

	const res = await call({ bearer: 'test-secret' });

	expect(mocks.runFeedbackPreview).toHaveBeenCalledWith('UC-quarter', digestId, expect.anything());
	expect(
		(await testDb().db.select().from(feedbackDigests).where(eq(feedbackDigests.id, digestId)).get())?.status
	).not.toBe('dry-run-failed');
	expect((await res.json()).feedbackPreview).toMatchObject({ commentsClassified: 1 });
});

test('a lease-release failure after a drained preview still counts the tick as worked', async () => {
	// The finally's UPDATE can transiently reject; if the rejection escaped
	// it would override `{ ran: true }`, letting the handler claim a second
	// channel's remote work on the spent deadline (codex, PR #178). The
	// release must fail loudly and preserve the result — the stale lease
	// self-expires anyway.
	await seedChannel('UC-prev');
	await seedChannel('UC-rot');
	await seedPendingPreview('UC-prev');
	mocks.runFeedbackPreview.mockResolvedValue({ commentsClassified: 1, commentsFailed: 0, pooled: 0, hasMore: false, findings: [] });
	mocks.runChannel.mockResolvedValue(runResult());
	const realUpdate = testDb().db.update.bind(testDb().db);
	const updateSpy = vi.spyOn(testDb().db, 'update').mockImplementation(((table: unknown) => {
		const builder = realUpdate(table as never) as {
			set: (v: Record<string, unknown>) => { where: (w: unknown) => Promise<unknown> };
		};
		const realSet = builder.set.bind(builder);
		builder.set = (values: Record<string, unknown>) => {
			const whereable = realSet(values);
			if (table === channels && 'leaseExpiresAt' in values && values.leaseExpiresAt === null) {
				whereable.where = async () => {
					throw new Error('sqlite exploded mid-release');
				};
			}
			return whereable;
		};
		return builder;
	}) as never);
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => {
		updateSpy.mockRestore();
		errorSpy.mockRestore();
	});

	const res = await call({ bearer: 'test-secret' });

	expect(mocks.runFeedbackPreview).toHaveBeenCalledTimes(1);
	// `ran` survived the release failure — no second workload this tick.
	expect(mocks.runChannel).not.toHaveBeenCalled();
	const body = await res.json();
	expect(body).toMatchObject({ ok: true, results: {} });
	expect(body.feedbackPreview).toMatchObject({ commentsClassified: 1 });
	// Loud, not silent — and the failed release leaves the lease in place
	// (it self-expires; the channel is not pinned forever).
	expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('lease release'), expect.anything(), expect.anything(), expect.anything());
	expect((await channelRow('UC-prev'))?.leaseExpiresAt).toBeTruthy();
});

test('a preview drain that spends the budget never claims a channel onto a dead deadline', async () => {
	// Regression for gitar+cubic PR #178: without the post-drain guard the
	// rotation claimed a channel on an expired deadline, runChannel returned
	// a deadline-partial, and runAndRecord stamped a fake failed/timeout —
	// bumping lastRunAt so the channel lost its rotation place.
	mocks.env.DRY_RUN = 'false';
	await seedChannel('UC-prev');
	await seedPendingPreview('UC-prev');
	const realNow = Date.now;
	const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow());
	mocks.runFeedbackPreview.mockImplementation(async () => {
		// The preview legitimately ran to the shared deadline.
		dateSpy.mockImplementation(() => realNow() + 60_000);
		return { commentsClassified: 0, commentsFailed: 0, pooled: 0, hasMore: false, findings: [] };
	});
	mocks.runChannel.mockResolvedValue(runResult({ dryRun: false, partial: true, stoppedReason: 'deadline' }));
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => {
		dateSpy.mockRestore();
		errorSpy.mockRestore();
	});

	const res = await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).not.toHaveBeenCalled();
	const row = await channelRow('UC-prev');
	expect(row?.lastRunAt).toBeNull();
	expect(row?.lastRunStatus).toBeNull();
	expect(await res.json()).toMatchObject({ results: {} });
});

test('contact retries get an early bounded slice of the shared cron budget', async () => {
	mocks.env.DRY_RUN = 'false';
	const now = 1_900_000_000_000;
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	onTestFinished(() => clock.mockRestore());
	await call({ query: 'test-secret' });
	const [contactDeadline] = mocks.retryContactNotifications.mock.calls[0];
	const sharedDeadline = mocks.retryStripeCustomerDeletions.mock.calls[0][1];
	expect(sharedDeadline).toBe(now + 20_000);
	expect(contactDeadline).toBe(Math.min(sharedDeadline, now + 5_000));
	expect(mocks.retryContactNotifications.mock.invocationCallOrder[0]).toBeLessThan(mocks.retryStripeCustomerDeletions.mock.invocationCallOrder[0]);
	expect(mocks.sweepZeroCreditAccounts).toHaveBeenCalledWith(expect.any(Number), sharedDeadline);
});


test.each(['live', 'preview'] as const)('a failing %s run with a dry-run boundary cannot starve another channel', async (phase) => {
	mocks.env.DRY_RUN = 'false';
	await seedDrainChannel('UC-failing', 'resume-page', { lastRunAt: '2026-01-01T00:00:00.000Z' });
	await seedChannel('UC-healthy', { lastRunAt: '2026-02-01T00:00:00.000Z' });
	mocks.runChannel.mockImplementation(async (id, options) => {
		if (id === 'UC-failing' && (phase === 'live' || options.forceDryRun)) {
			throw new Error('YouTube unavailable');
		}
		return runResult({ dryRun: false });
	});
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	onTestFinished(() => errorSpy.mockRestore());

	const failed = await call({ bearer: 'test-secret' });
	expect(failed.status).toBe(phase === 'live' ? 500 : 200);
	expectDrainState(await channelRow('UC-failing'), '2026-05-01T00:00:00.000Z', 'resume-page');

	const next = await call({ bearer: 'test-secret' });

	expect(await next.json()).toMatchObject({ results: { 'UC-healthy': { dryRun: false } } });
	expect((await channelRow('UC-healthy'))?.lastRunStatus).toBe('success');
	expectDrainState(await channelRow('UC-failing'), '2026-05-01T00:00:00.000Z', 'resume-page');
});

test('a multi-page dry-run yields to live moderation and resumes its saved page on its next turn', async () => {
	mocks.env.DRY_RUN = 'false';
	await seedDrainChannel('UC-preview', null, { lastRunAt: '2026-01-01T00:00:00.000Z' });
	await seedChannel('UC-live', { lastRunAt: '2026-02-01T00:00:00.000Z' });
	mocks.runChannel.mockImplementation(async (_id, options) => options.forceDryRun
		? runResult(options.window.pageToken === null
			? { windowComplete: false, windowNextPageToken: 'page-2' }
			: { windowComplete: true })
		: runResult({ dryRun: false }));

	await call({ bearer: 'test-secret' });
	expectDrainState(await channelRow('UC-preview'), '2026-05-01T00:00:00.000Z', 'page-2');
	const liveTurn = await call({ bearer: 'test-secret' });
	expect(await liveTurn.json()).toMatchObject({ results: { 'UC-live': { dryRun: false } } });
	await call({ bearer: 'test-secret' });

	expect(mocks.runChannel.mock.calls.map(([id]) => id)).toEqual(['UC-preview', 'UC-preview', 'UC-live', 'UC-preview', 'UC-preview']);
	expect(mocks.runChannel.mock.calls[4][1]).toMatchObject({ window: { pageToken: 'page-2' } });
	expectDrainState(await channelRow('UC-preview'), null, null);
});
