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
import { commitMatches, findDeploymentForCommit, main, triggerDeploy, verifyDeploymentQueued } from './coolify-deploy.mjs';

// 'test-token' is a synthetic credential fixture — maintainer-approved
// documented exception per AGENTS.md (approved 2026-07-30, PR #13 review).
const ORIGINAL_ENV = {
	COOLIFY_SERVER_URL: process.env.COOLIFY_SERVER_URL,
	COOLIFY_API_TOKEN: process.env.COOLIFY_API_TOKEN,
	COOLIFY: process.env.COOLIFY
};
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

beforeEach(() => {
	process.env.COOLIFY_SERVER_URL = 'https://coolify.example.com';
	process.env.COOLIFY_API_TOKEN = 'test-token';
	delete process.env.COOLIFY;
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

describe('coolify deploy guarantee', () => {
	it('fails loudly when COOLIFY_SERVER_URL is missing', async () => {
		delete process.env.COOLIFY_SERVER_URL;
		vi.stubGlobal('fetch', vi.fn());

		await expect(verifyDeploymentQueued('app-1', COMMIT, { timeoutMs: 50, pollMs: 10 })).rejects.toThrow('COOLIFY_SERVER_URL');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('fails loudly when neither COOLIFY_API_TOKEN nor COOLIFY is set', async () => {
		delete process.env.COOLIFY_API_TOKEN;
		delete process.env.COOLIFY;
		vi.stubGlobal('fetch', vi.fn());

		await expect(verifyDeploymentQueued('app-1', COMMIT, { timeoutMs: 50, pollMs: 10 })).rejects.toThrow('COOLIFY_API_TOKEN');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('accepts the local .env COOLIFY token as a fallback for the API token', async () => {
		delete process.env.COOLIFY_API_TOKEN;
		process.env.COOLIFY = 'local-token';
		vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));

		await verifyDeploymentQueued('app-1', COMMIT, { timeoutMs: 30, pollMs: 10 });

		const [, init] = fetch.mock.calls[0];
		expect(init.headers.Authorization).toBe('Bearer local-token');
	});

	it('matches the exact full commit SHA', () => {
		expect(commitMatches(COMMIT, COMMIT)).toBe(true);
	});

	it('matches a 12-char abbreviated commit', () => {
		expect(commitMatches(COMMIT.slice(0, 12), COMMIT)).toBe(true);
	});

	it('matches a 7-char abbreviated commit', () => {
		expect(commitMatches(COMMIT.slice(0, 7), COMMIT)).toBe(true);
	});

	it('does not match a different commit or an empty value', () => {
		expect(commitMatches('ffffffffffffffffffffffffffffffffffffffff', COMMIT)).toBe(false);
		expect(commitMatches(null, COMMIT)).toBe(false);
		expect(commitMatches(COMMIT, '')).toBe(false);
	});

	it('findDeploymentForCommit returns the queued deployment for the pushed commit', () => {
		const deployments = [
			{ deployment_uuid: 'old', commit: 'aaaaaaaaaaaa', status: 'finished' },
			{ deployment_uuid: 'new', commit: COMMIT.slice(0, 12), status: 'queued' }
		];
		const hit = findDeploymentForCommit(deployments, COMMIT);
		expect(hit?.deployment_uuid).toBe('new');
		expect(hit?.status).toBe('queued');
	});

	it('verifyDeploymentQueued polls the app deployments endpoint and returns the hit', async () => {
		const deployments = [{ deployment_uuid: 'dep-1', commit: COMMIT, status: 'in_progress' }];
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(deployments), { status: 200 })));

		const hit = await verifyDeploymentQueued('app-1', COMMIT, { timeoutMs: 200, pollMs: 10 });

		expect(hit).toEqual({ deploymentUuid: 'dep-1', status: 'in_progress', commit: COMMIT });
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('https://coolify.example.com/api/v1/deployments/applications/app-1?take=20');
		expect(init.headers.Authorization).toBe('Bearer test-token');
	});

	it('verifyDeploymentQueued returns null when no deployment appears before the timeout', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));

		const hit = await verifyDeploymentQueued('app-1', COMMIT, { timeoutMs: 40, pollMs: 10 });
		expect(hit).toBeNull();
	});

	it('throws on a non-OK API response instead of swallowing the failure', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('token rejected', { status: 401 })));

		await expect(verifyDeploymentQueued('app-1', COMMIT, { timeoutMs: 50, pollMs: 10 })).rejects.toThrow('401');
	});

	it('triggerDeploy POSTs /deploy?uuid=... with the token and returns the created deployments', async () => {
		const payload = { deployments: [{ message: 'Deployment queued.', resource_uuid: 'app-1', deployment_uuid: 'dep-2' }] };
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));

		const triggered = await triggerDeploy('app-1');

		expect(triggered).toEqual(payload.deployments);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('https://coolify.example.com/api/v1/deploy?uuid=app-1');
		expect(init.method).toBe('POST');
		expect(init.headers.Authorization).toBe('Bearer test-token');
	});

	it('fails loudly on a non-numeric --timeout-sec value instead of silently returning NaN', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
		await expect(main(['--timeout-sec', 'abc', 'app-1', COMMIT])).rejects.toThrow(/--timeout-sec|timeout-sec/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('fails loudly when --poll-sec is the last argument (missing value)', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
		await expect(main(['app-1', COMMIT, '--poll-sec'])).rejects.toThrow(/--poll-sec/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('fails loudly when the matched deployment ended in a terminal failure state', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(
			JSON.stringify([{ deployment_uuid: 'dep-bad', commit: COMMIT, status: 'failed' }]), { status: 200 })));

		await expect(main(['app-1', COMMIT])).resolves.toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('did not succeed'));
	});

	it('does not race a delayed webhook: a deployment found in the final recheck skips the API trigger', async () => {
		// With --timeout-sec 1 --poll-sec 1 the grace window is exactly one
		// poll (call 1 → []), and the final recheck before the fallback POST is
		// exactly call 2. If the delayed webhook's deployment appears there, the
		// script must NOT also POST /deploy (codeant — duplicate deploys).
		let calls = 0;
		vi.stubGlobal('fetch', vi.fn(async () => {
			calls += 1;
			if (calls >= 2) {
				return new Response(JSON.stringify([{ deployment_uuid: 'dep-late', commit: COMMIT, status: 'queued' }]), { status: 200 });
			}
			return new Response('[]', { status: 200 });
		}));

		const code = await main(['app-1', COMMIT, '--fallback', '--timeout-sec', '1', '--poll-sec', '1']);

		expect(code).toBe(0);
		const urls = fetch.mock.calls.map(([u]) => String(u));
		expect(urls.some((u) => u.includes('/deploy?uuid='))).toBe(false);
	});

	it('wraps a fetch network/timeout failure with the endpoint path (actionable context)', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('The operation was aborted due to timeout'); }));

		await expect(verifyDeploymentQueued('app-1', COMMIT, { timeoutMs: 50, pollMs: 10 }))
			.rejects.toThrow(/deployments\/applications\/app-1/);
	});

	it('the CLI actually runs when invoked directly — a relative argv[1] must enter the flow', () => {
		// Same guard regression as scripts/bunny-purge.mjs: with the server URL
		// missing the CLI must fail loudly (exit non-zero), proving the guard fired.
		const scriptPath = fileURLToPath(new URL('./coolify-deploy.mjs', import.meta.url));
		expect(() =>
			execFileSync(process.execPath, [scriptPath, 'app-1', COMMIT], {
				encoding: 'utf8',
				env: { ...process.env, COOLIFY_SERVER_URL: '', COOLIFY_API_TOKEN: '' },
				stdio: ['ignore', 'pipe', 'pipe']
			})
		).toThrow(/COOLIFY_SERVER_URL is not set/);
	});
});
