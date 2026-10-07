import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, { config } from './functions/cron.mjs';

// 'test-secret' is a synthetic credential fixture — maintainer-approved
// documented exception per AGENTS.md (approved 2026-07-30, PR #13 review).
const ORIGINAL_ENV = { APP_URL: process.env.APP_URL, CRON_SECRET: process.env.CRON_SECRET };

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
	process.env.APP_URL = 'https://moderaty.example.netlify.app';
	process.env.CRON_SECRET = 'test-secret';
	vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, dryRun: false, results: {} })));
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	if (ORIGINAL_ENV.APP_URL === undefined) delete process.env.APP_URL;
	else process.env.APP_URL = ORIGINAL_ENV.APP_URL;
	if (ORIGINAL_ENV.CRON_SECRET === undefined) delete process.env.CRON_SECRET;
	else process.env.CRON_SECRET = ORIGINAL_ENV.CRON_SECRET;
});

describe('scheduled cron trigger', () => {
	it('runs every minute during early operation (raise to */15 when user volume grows)', () => {
		expect(config.schedule).toBe('* * * * *');
	});

	it('sends the secret as a bearer header, never in the URL', async () => {
		await handler();

		expect(fetch).toHaveBeenCalledTimes(1);
		const [endpoint, init] = vi.mocked(fetch).mock.calls[0];
		expect(endpoint.href).toBe('https://moderaty.example.netlify.app/api/cron');
		expect(endpoint.search).toBe('');
		expect(init.headers.authorization).toBe('Bearer test-secret');
	});

	it('rejects when the endpoint does not answer within the timeout', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', vi.fn((_endpoint, init) => new Promise((_resolve, reject) => {
			init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
		})));

		const promise = handler();
		const assertion = expect(promise).rejects.toThrow(/abort/i);
		await vi.advanceTimersByTimeAsync(26_000);

		await assertion;
		vi.useRealTimers();
	});

	it('keeps the original timeout while reading a stalled response body', async () => {
		vi.useFakeTimers();
		let streamController;
		vi.stubGlobal('fetch', vi.fn(async (_endpoint, init) => {
			await new Promise((resolve) => setTimeout(resolve, 24_000));
			return new Response(new ReadableStream({
				start(controller) {
					streamController = controller;
					init.signal.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted', 'AbortError')));
				}
			}));
		}));
		let failure;
		const promise = handler().catch((error) => { failure = error; });
		try {
			await vi.advanceTimersByTimeAsync(25_000);
			expect(failure).toBeInstanceOf(Error);
			expect(failure.message).toMatch(/abort/i);
		} finally {
			streamController.error(new DOMException('Test cleanup aborted the body', 'AbortError'));
			await promise;
			vi.useRealTimers();
		}
	});

	it('bounds response bodies written to logs and errors', async () => {
		const huge = (overrides) => ({ results: { channel: { note: 'x'.repeat(2000) } }, ...overrides });
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(huge({ ok: true }))));

		await handler();

		expect(vi.mocked(console.log).mock.calls[0][0].length).toBeLessThan(600);

		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(huge({ ok: false }), 500)));

		const failure = await handler().catch((error) => error);
		expect(failure.message.length).toBeLessThan(600);
	});

	it('throws when CRON_SECRET is not configured', async () => {
		delete process.env.CRON_SECRET;

		await expect(handler()).rejects.toThrow('CRON_SECRET');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('throws when APP_URL is not configured', async () => {
		delete process.env.APP_URL;

		await expect(handler()).rejects.toThrow('APP_URL');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('surfaces the network cause when the endpoint is unreachable', async () => {
		const cause = new Error('getaddrinfo ENOTFOUND moderaty.netlify.app');
		cause.code = 'ENOTFOUND';
		vi.stubGlobal('fetch', vi.fn(async () => {
			throw new TypeError('fetch failed', { cause });
		}));

		const error = await handler().catch((e) => e);
		expect(error.message).toContain('dns');
		expect(error.message).toContain('ENOTFOUND');
	});

	it('throws loudly when the cron endpoint fails', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, results: { channel: { error: 'YouTube quota' } } }, 500)));

		await expect(handler()).rejects.toThrow('500');
	});

	it('fails the invocation when a 200 payload reports a sweep failure', async () => {
		// codex: HTTP 200 alone cannot see an ops failure — `ok:false`, a
		// spent budget, or a sweep error all hide inside the JSON body.
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, zeroCreditSweepError: 'db exploded', results: {} })));

		await expect(handler()).rejects.toThrow(/zeroCreditSweepError/);
	});

	it('fails the invocation when a 200 reports an exhausted run budget', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, budgetExhausted: true, results: {} })));

		await expect(handler()).rejects.toThrow(/budget/);
	});

	it('fails the invocation on ok:false with no sweep error detail', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, results: {} })));

		await expect(handler()).rejects.toThrow(/ok:false/);
	});

	it('fails the invocation on a non-JSON success body', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 })));

		await expect(handler()).rejects.toThrow(/non-JSON/);
	});

	it.each([
		['a JSON scalar', '42'],
		['a JSON string', '"ok"'],
		['a JSON boolean', 'true'],
		['a JSON array', '[]'],
		['an object missing the cron fields', '{}']
	])('fails the invocation on a 200 answering %s', async (_label, body) => {
		// cubic: a malformed-but-parseable response is not a healthy tick —
		// classifying it as one would hide a proxy/scheduler failure.
		vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

		await expect(handler()).rejects.toThrow(/invalid/);
	});

	it.each(['token', 'credits'])('suppresses a non-OK whose only failure is the owner category %s', async (category) => {
		// Same contract as the local driver: 'credits'/'token' failures are
		// dashboard-visible and self-resolving — an invocation failure every
		// minute would be pure noise.
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, results: { UC1: { error: category } } }, 500)));
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

		await expect(handler()).resolves.toBeUndefined();
		expect(warning).toHaveBeenCalled();
	});

	it.each(['token', 'credits'])('does not suppress a stale-preview cleanup failure behind %s errors', async (category) => {
		const payload = { ok: false, feedbackPreviewSweepError: true, results: { UC1: { error: category } } };
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload, 500)));

		await expect(handler()).rejects.toThrow('feedbackPreviewSweepError');
	});
});
