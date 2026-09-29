import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pingHealthcheck, tickOnce } from './dev-cron.mjs';

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

	it('fails the tick when a sweep failed — the payload field is otherwise invisible to the scheduler', async () => {
		const payload = { ok: false, sweepError: 'retention sweep blew up', results: {} };
		vi.stubGlobal('fetch', vi.fn(async () => cronResponse(payload)));

		await expect(tickOnce()).rejects.toThrow('sweepError: retention sweep blew up');
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
