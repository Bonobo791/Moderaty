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
//
// CLI behavior tests for the optional Bunny purge script
// (scripts/bunny/purge-bunny-cache.mjs). The script must no-op (exit 0)
// without credentials — a local build/dev run must never fail — and must
// fail fast (exit 1, before any network call) on an invalid target, so a
// typo'd path cannot silently purge nothing or something foreign.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('./purge-bunny-cache.mjs', import.meta.url));

function run(env) {
	return spawnSync(process.execPath, [scriptPath], {
		encoding: 'utf8',
		env: { ...process.env, ...env },
		timeout: 15_000
	});
}

describe('purge-bunny-cache CLI', () => {
	it('no-ops with exit 0 when BUNNY_API_KEY is missing', () => {
		const res = run({ BUNNY_API_KEY: '', BUNNY_PULL_ZONE_ID: '' });
		expect(res.status).toBe(0);
		expect(res.stdout).toMatch(/Skipped \(BUNNY_API_KEY not set\)/);
	});

	it('no-ops with exit 0 when the zone ID is missing for a full purge', () => {
		const res = run({ BUNNY_API_KEY: 'test-access-key', BUNNY_PULL_ZONE_ID: '' });
		expect(res.status).toBe(0);
		expect(res.stdout).toMatch(/Skipped \(BUNNY_PULL_ZONE_ID not set\)/);
	});

	it('fails fast when path targets are given without SITE_URL or APP_URL', () => {
		const res = spawnSync(process.execPath, [scriptPath, '/pricing/'], {
			encoding: 'utf8',
			env: { ...process.env, BUNNY_API_KEY: 'test-access-key', BUNNY_PULL_ZONE_ID: '', SITE_URL: '', APP_URL: '' },
			timeout: 15_000
		});
		expect(res.status).toBe(1);
		expect(res.stderr).toMatch(/SITE_URL \(or APP_URL\) is required/);
	});

	it('fails fast on an invalid (foreign-host) target before any network call', () => {
		const res = spawnSync(process.execPath, [scriptPath, 'https://evil.example/pricing'], {
			encoding: 'utf8',
			env: {
				...process.env,
				BUNNY_API_KEY: 'test-access-key',
				BUNNY_PULL_ZONE_ID: '',
				SITE_URL: 'https://moderaty.example'
			},
			timeout: 15_000
		});
		expect(res.status).toBe(1);
		expect(res.stderr).toMatch(/Invalid target/);
	});
});
