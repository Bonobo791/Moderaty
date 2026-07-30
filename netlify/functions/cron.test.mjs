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
import handler, { config } from './cron.mjs';

const ORIGINAL_ENV = { URL: process.env.URL, CRON_SECRET: process.env.CRON_SECRET };

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
	process.env.URL = 'https://moderaty.example.netlify.app';
	process.env.CRON_SECRET = 'test-secret';
	vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, dryRun: false, results: {} })));
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (ORIGINAL_ENV.URL === undefined) delete process.env.URL;
	else process.env.URL = ORIGINAL_ENV.URL;
	if (ORIGINAL_ENV.CRON_SECRET === undefined) delete process.env.CRON_SECRET;
	else process.env.CRON_SECRET = ORIGINAL_ENV.CRON_SECRET;
});

describe('scheduled cron trigger', () => {
	it('runs every 15 minutes', () => {
		expect(config.schedule).toBe('*/15 * * * *');
	});

	it('calls the deployed site cron endpoint with the secret', async () => {
		await handler();

		expect(fetch).toHaveBeenCalledTimes(1);
		const endpoint = vi.mocked(fetch).mock.calls[0][0];
		expect(endpoint.href).toBe('https://moderaty.example.netlify.app/api/cron?secret=test-secret');
	});

	it('throws when CRON_SECRET is not configured', async () => {
		delete process.env.CRON_SECRET;

		await expect(handler()).rejects.toThrow('CRON_SECRET');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('throws when the site URL is not configured', async () => {
		delete process.env.URL;

		await expect(handler()).rejects.toThrow('URL');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('throws loudly when the cron endpoint fails', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, results: { channel: { error: 'YouTube quota' } } }, 500)));

		await expect(handler()).rejects.toThrow('500');
	});
});
