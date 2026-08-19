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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tickOnce } from './dev-cron.mjs';

// 'test-secret' is a synthetic credential fixture — maintainer-approved
// documented exception per AGENTS.md (approved 2026-07-30, PR #13 review).
const ORIGINAL_ENV = { APP_URL: process.env.APP_URL, CRON_SECRET: process.env.CRON_SECRET };

beforeEach(() => {
	process.env.APP_URL = 'http://localhost:5173';
	process.env.CRON_SECRET = 'test-secret';
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	if (ORIGINAL_ENV.APP_URL === undefined) delete process.env.APP_URL;
	else process.env.APP_URL = ORIGINAL_ENV.APP_URL;
	if (ORIGINAL_ENV.CRON_SECRET === undefined) delete process.env.CRON_SECRET;
	else process.env.CRON_SECRET = ORIGINAL_ENV.CRON_SECRET;
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
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));

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
});
