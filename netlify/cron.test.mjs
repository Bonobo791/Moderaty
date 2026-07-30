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
	it('runs every 15 minutes', () => {
		expect(config.schedule).toBe('*/15 * * * *');
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

	it('throws loudly when the cron endpoint fails', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, results: { channel: { error: 'YouTube quota' } } }, 500)));

		await expect(handler()).rejects.toThrow('500');
	});
});
