import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
		expect(thrown.message).toContain('sweep blew up');
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

		await expect(tickOnce()).rejects.toThrow('sweepError: retention sweep blew up');
	});

	it('does not suppress a zero-credit sweep failure behind owner-actionable channel errors', async () => {
		// A 500 whose channel errors are all owner-actionable is normally
		// silenced — but a failed retention sweep rides the same payload and
		// must still trip the operator alert.
		const payload = { ok: false, results: { UC1: { error: 'token' } }, zeroCreditSweepError: 'sweep blew up' };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, 500)));

		await expect(tickOnce()).rejects.toThrow('zeroCreditSweepError');
	});

	it('names the zero-credit sweep failure on a 200 instead of the generic ok:false', async () => {
		const payload = { ok: false, zeroCreditSweepError: 'db down', results: {} };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).rejects.toThrow('zeroCreditSweepError: db down');
	});

	it.each(['token', 'credits'])('does not suppress Stripe scrub failures behind %s errors in either scheduler', async (category) => {
		const payload = { ok: false, results: { UC1: { error: category } }, stripeScrubSweepError: 'scrub failed' };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload, 500)));
		const { default: netlifyCron } = await import('../netlify/functions/cron.mjs');

		await expect(tickOnce()).rejects.toThrow('stripeScrubSweepError');
		await expect(netlifyCron()).rejects.toThrow('stripeScrubSweepError');
	});

	it.each(['dryRunWindow', 'digest'])('fails the tick when the %s job reports an error on a 200', async (field) => {
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
		expect(console.error).toHaveBeenCalledWith('healthcheck ping failed:', 'dns failure');
	});
});
