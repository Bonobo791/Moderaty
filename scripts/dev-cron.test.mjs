import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDriverArgs, pingHealthcheck, scheduleTicks, tickOnce } from './dev-cron.mjs';

// 'test-secret' is a synthetic credential fixture — maintainer-approved
// documented exception per AGENTS.md (approved 2026-07-30, PR #13 review).
const ORIGINAL_ENV = {
	APP_URL: process.env.APP_URL,
	CRON_SECRET: process.env.CRON_SECRET,
	HEALTHCHECK_PING_URL: process.env.HEALTHCHECK_PING_URL
};

function cronResponse(payload, status = 200) {
	return new Response(JSON.stringify(payload), { status });
}

beforeEach(() => {
	process.env.APP_URL = 'http://localhost:5173';
	process.env.CRON_SECRET = 'test-secret';
	delete process.env.HEALTHCHECK_PING_URL;
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const key of ['APP_URL', 'CRON_SECRET', 'HEALTHCHECK_PING_URL']) {
		if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
		else process.env[key] = ORIGINAL_ENV[key];
	}
});

describe('dev cron tick', () => {
	it.each([
		[{ ok: true, results: {} }, 200, 0, 2],
		[{ ok: false, results: { channel: { error: 'credits' } } }, 500, 0, 2],
		[{ ok: false, results: {}, autoTopupSweepError: 'test-secret' }, 200, 1, 1],
		[{ ok: false, results: { channel: { error: 'token' } }, autoTopupSweepError: 'test-secret' }, 500, 1, 1],
		[{ ok: true }, 200, 1, 1]
	])('--once keeps alert exit and health-ping behavior for fixture %j', (payload, status, exit, requests) => {
		// The child has a complete fetch stub before loading the driver. No
		// app, provider, monitor, database or mail transport is contacted.
		const bootstrap = `let requests = 0; globalThis.fetch = async () => { requests++; return new Response(${JSON.stringify(JSON.stringify(payload))}, { status: ${status} }); }; process.on('exit', () => console.error('fixture-requests=' + requests));`;
		const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, fileURLToPath(new URL('dev-cron.mjs', import.meta.url)), '--once'], {
			encoding: 'utf8', env: { CRON_SECRET: 'test-secret', APP_URL: 'http://fixture.invalid', HEALTHCHECK_PING_URL: 'http://monitor.invalid' }
		});
		expect(child.status).toBe(exit);
		expect(child.stderr).toContain(`fixture-requests=${requests}`);
		expect(child.stderr + child.stdout).not.toContain('test-secret');
	});

	it.each([200, 500])('retains provider HTTP status through both wrappers on HTTP %s', async (status) => {
		const payload = { ok: false, results: {}, autoTopupSweepError: 'test-secret',
			failureDiagnostics: [{ sweep: 'autoTopupSweepError', operation: 'auto_topup', category: 'http', httpStatus: 500, provider: 'stripe', service: 'payments' }] };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, status)));
		const { default: netlifyCron } = await import('../netlify/functions/cron.mjs');
		for (const run of [tickOnce, netlifyCron]) {
			const error = await run().catch((e) => e);
			expect(error.message).toContain('httpStatus=500');
			expect(error.message).toContain('provider=stripe');
			expect(error.message).not.toContain('test-secret');
		}
	});

	it('loads in the Docker runtime layout without source files or runtime credentials', () => {
		const runtime = mkdtempSync(join(tmpdir(), 'moderaty-cron-runtime-'));
		try {
			// Dockerfile ships scripts/ and package.json, but omits src/. Import
			// only: the direct-execution guard must prevent any request or send.
			cpSync(fileURLToPath(new URL('.', import.meta.url)), join(runtime, 'scripts'), { recursive: true });
			writeFileSync(join(runtime, 'package.json'), '{"type":"module"}');
			const probe = spawnSync(process.execPath, ['--input-type=module', '-e', 'globalThis.fetch = () => { throw new Error("Unexpected network request"); }; await import(process.argv[1]);', pathToFileURL(join(runtime, 'scripts/dev-cron.mjs')).href], { encoding: 'utf8', env: {} });
			expect(probe.stderr).toBe('');
			expect(probe.status).toBe(0);
		} finally { rmSync(runtime, { recursive: true, force: true }); }
	});

	it.each([200, 500])('keeps root diagnostics in bounded, sanitized scheduler output on HTTP %s', async (status) => {
		const payload = {
			ok: false, results: { 'private-customer': { error: 'token' } },
			noise: 'test-secret'.repeat(500), autoTopupSweepError: 'Failed query: private SQL params: test-secret',
			cronRunId: '11111111-1111-4111-8111-111111111111',
			failureDiagnostics: [{ sweep: 'autoTopupSweepError', operation: 'auto_topup.lifetime_candidates',
				category: 'dns', code: 'EAI_AGAIN', syscall: 'getaddrinfo', provider: 'turso', service: 'database',
				cronRunId: '11111111-1111-4111-8111-111111111111', message: 'test-secret', headers: { authorization: 'test-secret' } }]
		};
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, status)));
		const { default: netlifyCron } = await import('../netlify/functions/cron.mjs');
		for (const run of [tickOnce, netlifyCron]) {
			const error = await run().catch((e) => e);
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain('EAI_AGAIN');
			expect(error.message).toContain('getaddrinfo');
			expect(error.message).toContain('auto_topup.lifetime_candidates');
			expect(error.message).toContain(payload.cronRunId);
			expect(error.message.length).toBeLessThan(6000);
			for (const forbidden of ['test-secret', 'private-customer', 'private SQL', 'authorization']) expect(error.message).not.toContain(forbidden);
		}
		const output = console.log.mock.calls.flat().join(' ');
		expect(output).toContain('EAI_AGAIN');
		expect(output).not.toContain('test-secret');
		expect(output).not.toContain('private-customer');
	});

	it('sanitizes nested transport failures without replaying the cron request', async () => {
		const root = Object.assign(new Error('https://user:test-secret@private-host.invalid/'), { code: 'EAI_AGAIN', syscall: 'getaddrinfo' });
		const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed test-secret', { cause: root }));
		const error = await tickOnce(fetchImpl).catch((e) => e);
		expect(error.message).toContain('EAI_AGAIN');
		expect(error.message).not.toContain('test-secret');
		expect(error.message).not.toContain('private-host');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('fails loudly when CRON_SECRET is missing', async () => {
		delete process.env.CRON_SECRET;
		vi.stubGlobal('fetch', vi.fn());

		await expect(tickOnce()).rejects.toThrow('CRON_SECRET');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('calls the app cron endpoint with the secret in a bearer header and returns the payload', async () => {
		const payload = { ok: true, dryRun: false, results: { UC1: { fetched: 3 } } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		const res = await tickOnce();

		expect(res).toEqual(payload);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('http://localhost:5173/api/cron');
		expect(init.headers.Authorization).toBe('Bearer test-secret');
		// The logged line must never carry a raw newline from the payload —
		// that is how a response forges log lines (S5145).
		expect(console.log).toHaveBeenCalledTimes(1);
		expect(console.log.mock.calls[0][0]).not.toMatch(/[\r\n]/);
	});

	it('throws on a non-OK response instead of swallowing the failure', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

		await expect(tickOnce()).rejects.toThrow('500');
	});

	it('throws on a 200 that is not JSON', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>proxy page</html>', { status: 200 })));

		await expect(tickOnce()).rejects.toThrow('non-JSON');
	});

	it.each([
		['a JSON array', '[]'],
		['a JSON scalar', '42'],
		['a JSON string', '"ok"'],
		['a boolean', 'true'],
		['an object without the cron shape', '{}'],
		['a non-boolean ok', '{"ok":"yes","results":{}}'],
		['an array results', '{"ok":true,"results":[]}']
	])('throws on a 200 carrying %s — a healthy read would hide a proxy failure', async (_label, body) => {
		// cubic: only the full `{ ok: boolean, results: object }` shape counts
		// as an answered tick — anything else is a malformed/proxy response
		// and must fail the invocation (and skip the healthcheck ping).
		vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

		await expect(tickOnce()).rejects.toThrow('invalid');
	});

	it('strips CR/LF from sweep error text before it reaches the thrown Error', async () => {
		// cubic: detailProblems interpolates error text into the thrown Error —
		// a response carrying newlines would forge extra log lines even though
		// renderTick sanitizes the response log.
		const payload = { ok: false, sweepError: 'sweep blew up\n[INFO] all clear', results: {} };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		const thrown = await tickOnce().catch((e) => e);
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown.message).not.toMatch(/[\r\n]/);
		expect(thrown.message).toContain('sweepError');
		expect(thrown.message).not.toContain('sweep blew up');
	});

	it('does not fail the tick when every channel failure is owner-actionable', async () => {
		// A thrown channel run answers 500 with a sanitized category; 'token'
		// means the owner must reconnect — persistent and dashboard-visible,
		// so a per-minute scheduler email would be noise.
		const payload = { ok: false, results: { UC1: { error: 'token' } } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, 500)));

		const res = await tickOnce();

		expect(res).toEqual(payload);
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('token'));
	});

	it.each(['credits', 'token'])('suppresses the owner-actionable category %s on a 500', async (category) => {
		const payload = { ok: false, results: { UC1: { error: category } } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, 500)));

		await expect(tickOnce()).resolves.toEqual(payload);
	});

	it('still throws when a suppressed category shares the tick with an ops failure', async () => {
		const payload = { ok: false, results: { UC1: { error: 'token' }, UC2: { error: 'quota' } } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, 500)));

		await expect(tickOnce()).rejects.toThrow('500');
	});

	it('throws on a 500 whose only channel error is an ops category', async () => {
		const payload = { ok: false, results: { UC1: { error: 'scoring' } } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, 500)));

		await expect(tickOnce()).rejects.toThrow('scoring');
	});

	it('an out-of-credits channel result on a 200 is a healthy tick', async () => {
		const payload = { ok: true, results: { UC1: { fetched: 2, outOfCredits: true } } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).resolves.toEqual(payload);
	});

	it('fails the tick when a channel run ended partial on the tick deadline', async () => {
		// codex: a partial deadline return rides the 200 payload — classifying
		// only `entry.error` let a moderation run that never finished read as
		// a healthy tick to the dead-man ping.
		const payload = { ok: true, results: { UC1: { fetched: 2, acted: 1, partial: true, stoppedReason: 'deadline' } } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).rejects.toThrow('timed out');
	});

	it('does not fail the tick for a channel paused mid-run — deactivation is owner-actionable', async () => {
		const payload = { ok: true, results: { UC1: { partial: true, stoppedReason: 'deactivated' } } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).resolves.toEqual(payload);
	});

	it('fails the tick when a sweep failed — the payload field is otherwise invisible to the scheduler', async () => {
		const payload = { ok: false, sweepError: 'retention sweep blew up', results: {} };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).rejects.toThrow('sweepError: failure (no safe diagnostic)');
	});

	it('does not suppress a zero-credit sweep failure behind owner-actionable channel errors', async () => {
		// A 500 whose channel errors are all owner-actionable is normally
		// silenced — but a failed retention sweep rides the same payload and
		// must still trip the operator alert.
		const payload = { ok: false, results: { UC1: { error: 'token' } }, zeroCreditSweepError: 'sweep blew up' };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, 500)));

		await expect(tickOnce()).rejects.toThrow('zeroCreditSweepError');
	});

	it.each(['token', 'credits'])('does not suppress a stale-preview cleanup failure behind %s errors', async (category) => {
		const payload = { ok: false, feedbackPreviewSweepError: true, results: { UC1: { error: category } } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, 500)));

		await expect(tickOnce()).rejects.toThrow('feedbackPreviewSweepError');
	});

	it('names the zero-credit sweep failure on a 200 instead of the generic ok:false', async () => {
		const payload = { ok: false, zeroCreditSweepError: 'db down', results: {} };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).rejects.toThrow('zeroCreditSweepError: failure (no safe diagnostic)');
	});

	it.each(['token', 'credits'])('does not suppress Stripe scrub failures behind %s errors in either scheduler', async (category) => {
		const payload = { ok: false, results: { UC1: { error: category } }, stripeScrubSweepError: 'scrub failed' };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, 500)));
		const { default: netlifyCron } = await import('../netlify/functions/cron.mjs');

		await expect(tickOnce()).rejects.toThrow('stripeScrubSweepError');
		await expect(netlifyCron()).rejects.toThrow('stripeScrubSweepError');
	});

	it.each(['dryRunWindow', 'digest', 'feedbackPreview'])('fails the tick when the %s job reports an error on a 200', async (field) => {
		// codex: the aux jobs catch their failures into top-level `{error}`
		// fields — a classifier that only inspects sweeps + results lets a
		// digest that fails every rotation read as a healthy tick forever.
		const payload = { ok: true, results: { UC1: { fetched: 3 } }, [field]: { error: 'openai blew up' } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).rejects.toThrow(field);
	});

	it('does not suppress an aux-job failure behind an owner-actionable channel error', async () => {
		const payload = { ok: false, results: { UC1: { error: 'token' } }, digest: { error: 'error' } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, 500)));

		await expect(tickOnce()).rejects.toThrow('digest');
	});

	it('treats successful aux-job results as healthy', async () => {
		const payload = { ok: true, results: { UC1: { fetched: 3 } }, dryRunWindow: { fetched: 5, windowComplete: true }, digest: { generated: true } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).resolves.toEqual(payload);
	});

	it('fails the tick when sweeps consumed the whole run budget', async () => {
		const payload = { ok: true, budgetExhausted: true, results: {} };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).rejects.toThrow('budget');
	});

	it('fails the tick when the run-health bookkeeping write was lost', async () => {
		const payload = { ok: true, bookkeepingError: true, results: { UC1: { fetched: 1 } } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).rejects.toThrow('bookkeeping');
	});

	it('fails the tick when per-account zero-credit evaluations failed — the count is the only alert channel', async () => {
		// `ok` stays true for per-item sweep errors by design, so a user whose
		// evaluation throws every rotation would retry silently forever
		// without this check (codeant).
		const payload = { ok: true, zeroCreditItemErrors: 2, results: {} };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).rejects.toThrow('zeroCreditItemErrors');
	});

	it('does not suppress zero-credit item failures behind owner-actionable channel errors on a 500', async () => {
		const payload = { ok: false, zeroCreditItemErrors: 1, results: { UC1: { error: 'credits' } } };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, 500)));

		await expect(tickOnce()).rejects.toThrow('zeroCreditItemErrors');
	});
});

describe('driver args', () => {
	it('rejects a zero or negative interval — setInterval(0) would hot-loop the endpoint', async () => {
		expect(parseDriverArgs(['--interval-ms', '0'])).toBeNull();
		expect(parseDriverArgs(['--interval-ms', '-5000'])).toBeNull();
	});

	it('rejects an interval past the signed 32-bit timer limit — setTimeout clamps it to 1 ms', async () => {
		// cubic: --interval-ms 2147483648 parses fine but Node folds it to a
		// 1 ms delay, hot-looping /api/cron instead of running daily.
		expect(parseDriverArgs(['--interval-ms', '2147483647'])).toEqual({ once: false, intervalMs: 2147483647 });
		expect(parseDriverArgs(['--interval-ms', '2147483648'])).toBeNull();
	});

	it('rejects a non-numeric or missing interval value', async () => {
		expect(parseDriverArgs(['--interval-ms', 'abc'])).toBeNull();
		expect(parseDriverArgs(['--interval-ms'])).toBeNull();
		expect(parseDriverArgs(['--bogus'])).toBeNull();
	});

	it('parses valid flag combinations', async () => {
		expect(parseDriverArgs(['--once'])).toEqual({ once: true, intervalMs: 60000 });
		expect(parseDriverArgs(['--interval-ms', '5000'])).toEqual({ once: false, intervalMs: 5000 });
		expect(parseDriverArgs([])).toEqual({ once: false, intervalMs: 60000 });
	});
});

describe('tick scheduling', () => {
	it('never overlaps ticks — the next run arms only after the current tick settles', async () => {
		// setInterval fires on the wall clock: a tick slower than the interval
		// would stack concurrent runs fighting over the same channel claims
		// (codeant). The scheduler re-arms from the tick's settle, so at most
		// one tick is ever in flight.
		const pending = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const tick = vi.fn(async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight -= 1;
			return true;
		});
		scheduleTicks(tick, 50, (fn) => pending.push(fn));
		expect(pending).toHaveLength(1);
		for (let i = 0; i < 3; i++) {
			const step = pending.shift();
			expect(step).toBeTypeOf('function');
			step();
			// The tick is still running — nothing may be armed yet.
			expect(pending).toHaveLength(0);
			await vi.waitFor(() => expect(pending).toHaveLength(1));
		}
		expect(tick).toHaveBeenCalledTimes(3);
		expect(maxInFlight).toBe(1);
	});
});

describe('healthcheck ping', () => {
	it('does nothing when HEALTHCHECK_PING_URL is unset', async () => {
		vi.stubGlobal('fetch', vi.fn());

		await pingHealthcheck();

		expect(fetch).not.toHaveBeenCalled();
	});

	it('GETs the configured URL', async () => {
		process.env.HEALTHCHECK_PING_URL = 'https://hc.example.com/ping/abc';
		vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

		await pingHealthcheck();

		expect(fetch).toHaveBeenCalledWith('https://hc.example.com/ping/abc', expect.objectContaining({ signal: expect.any(AbortSignal) }));
	});

	it('logs but never throws when the monitor is down — a ping failure must not fail a healthy tick', async () => {
		process.env.HEALTHCHECK_PING_URL = 'https://hc.example.com/ping/abc';
		vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));

		await expect(pingHealthcheck()).resolves.toBeUndefined();
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('502'));

		fetch.mockRejectedValueOnce(new Error('dns failure'));
		await expect(pingHealthcheck()).resolves.toBeUndefined();
		expect(console.error).toHaveBeenCalledWith('healthcheck ping failed:', expect.stringContaining('operation=healthcheck_ping'));
		expect(console.error.mock.calls.flat().join(' ')).not.toContain('dns failure');
	});
});


describe('contact delivery health', () => {
	it.each([{ contactNotificationErrors: 1 }, { contactNotificationSweepError: 'database unavailable' }])('alerts operators on contact failures even alongside an owner-actionable channel failure (%j)', async (contactFailure) => {
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse({ ok: false, results: { UC1: { error: 'token' } }, ...contactFailure }, 500)));
		await expect(tickOnce()).rejects.toThrow(/contactNotification/);
	});
});

describe.each(['driver', 'netlify'])('%s welcome delivery health', wrapper => {
 const invoke = async () => wrapper === 'driver' ? tickOnce() : (await import('../netlify/functions/cron.mjs')).default();
 it.each([
  [{ welcomeEmailSweepError: 'database unavailable' }, 'welcomeEmailSweepError: failure (no safe diagnostic)'],
  [{ welcomeEmailErrors: 1 }, 'welcomeEmailErrors: 1 delivery attempt(s) failed'],
  [{ welcomeEmailEnrollmentErrors: 1 }, 'welcomeEmailEnrollmentErrors: 1 account enrollment(s) failed'],
  [{ welcomeEmailAmbiguous: 1 }, 'welcomeEmailAmbiguous: reconciliation required']
 ])('names the actionable welcome problem in a 200 response (%j)', async (failure, expected) => {
  vi.stubGlobal('fetch', vi.fn(async () => cronResponse({ ok: false, results: {}, ...failure })));
  await expect(invoke()).rejects.toThrow(expected);
 });
 it('does not suppress welcome failures behind an owner-actionable channel error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => cronResponse({ ok: false, results: { UC1: { error: 'token' } }, welcomeEmailErrors: 1 }, 500)));
  await expect(invoke()).rejects.toThrow(/welcomeEmailErrors/);
 });
 it('zero welcome counters remain healthy', async () => {
  const payload = { ok: true, results: {}, welcomeEmailEnrollmentErrors: 0, welcomeEmailErrors: 0, welcomeEmailAmbiguous: 0 };
  vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));
  await expect(invoke()).resolves.toEqual(wrapper === 'driver' ? payload : undefined);
 });
});
