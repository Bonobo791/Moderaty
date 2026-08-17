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
import { purgeSite } from './bunny-purge.mjs';

// 'test-access-key' is a synthetic credential fixture — maintainer-approved
// documented exception per AGENTS.md (approved 2026-07-30, PR #13 review).
const ORIGINAL_ENV = {
	BUNNY_ACCESS_KEY: process.env.BUNNY_ACCESS_KEY,
	BUNNY_PURGE_URL: process.env.BUNNY_PURGE_URL,
	APP_URL: process.env.APP_URL
};

beforeEach(() => {
	process.env.BUNNY_ACCESS_KEY = 'test-access-key';
	process.env.APP_URL = 'https://moderaty.example';
	delete process.env.BUNNY_PURGE_URL;
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe('bunny purge', () => {
	it('fails loudly when BUNNY_ACCESS_KEY is missing', async () => {
		delete process.env.BUNNY_ACCESS_KEY;
		vi.stubGlobal('fetch', vi.fn());

		await expect(purgeSite()).rejects.toThrow('BUNNY_ACCESS_KEY');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('fails loudly when neither BUNNY_PURGE_URL nor APP_URL is set', async () => {
		delete process.env.APP_URL;
		vi.stubGlobal('fetch', vi.fn());

		await expect(purgeSite()).rejects.toThrow('BUNNY_PURGE_URL');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('purges the whole site as an async wildcard URL with the key in an AccessKey header', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

		await purgeSite();

		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('https://api.bunny.net/purge?url=https%3A%2F%2Fmoderaty.example%2F*&async=true');
		expect(init.method).toBe('POST');
		expect(init.headers.AccessKey).toBe('test-access-key');
	});

	it('prefers BUNNY_PURGE_URL over APP_URL for the wildcard pattern', async () => {
		process.env.BUNNY_PURGE_URL = 'https://cdn.moderaty.example';
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

		await purgeSite();

		const [url] = fetch.mock.calls[0];
		expect(url).toContain('url=https%3A%2F%2Fcdn.moderaty.example%2F*');
	});

	it('returns the payload and logs it without raw newlines (S5145)', async () => {
		const payload = { async: true, processedUrls: 1 };
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));

		await expect(purgeSite()).resolves.toEqual(payload);
		expect(console.log).toHaveBeenCalledTimes(1);
		expect(console.log.mock.calls[0][0]).not.toMatch(/[\r\n]/);
	});

	it('throws on a non-OK response instead of swallowing the failure', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('AccessKey was rejected', { status: 401 })));

		await expect(purgeSite()).rejects.toThrow('401');
	});
});
