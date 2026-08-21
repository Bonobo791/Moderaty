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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

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
		expect(error.message).toContain('fetch failed');
		expect(error.message).toContain('ENOTFOUND');
	});

	it('throws loudly when the cron endpoint fails', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, results: { channel: { error: 'YouTube quota' } } }, 500)));

		await expect(handler()).rejects.toThrow('500');
	});
});
