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

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

	it('the CLI actually runs when invoked directly — a relative argv[1] must enter the purge flow', () => {
		// Coolify / GitHub Actions invoke `node scripts/bunny-purge.mjs` with a
		// RELATIVE argv[1]; a naive import.meta.url comparison never matches
		// and the script exits 0 without purging (coderabbit). With the key
		// missing the CLI must fail loudly (exit non-zero) — a silent exit 0
		// means the guard never fired.
		const scriptPath = fileURLToPath(new URL('./bunny-purge.mjs', import.meta.url));
		expect(() =>
			execFileSync(process.execPath, [scriptPath], {
				encoding: 'utf8',
				env: { ...process.env, BUNNY_ACCESS_KEY: '', APP_URL: 'https://moderaty.example' },
				stdio: ['ignore', 'pipe', 'pipe']
			})
		).toThrow(/BUNNY_ACCESS_KEY is not set/);
	});
});
