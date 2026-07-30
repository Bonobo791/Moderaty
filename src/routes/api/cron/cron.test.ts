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

import { beforeEach, expect, test, vi } from 'vitest';
import { setupTestDb, testDb } from '$lib/server/testdb';
import { channels } from '$lib/server/db/schema';

// Synthetic credential fixture — same maintainer-approved exception as
// netlify/functions/cron.test.mjs (2026-07-30, PR #13 review, per AGENTS.md).
const mocks = vi.hoisted(() => ({
	env: { CRON_SECRET: 'test-secret', DRY_RUN: 'true' } as Record<string, string | undefined>,
	runChannel: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/pipeline', () => ({ runChannel: mocks.runChannel }));

import { GET } from './+server';

setupTestDb(['channels']);

beforeEach(() => {
	mocks.env.CRON_SECRET = 'test-secret';
	mocks.env.DRY_RUN = 'true';
	vi.clearAllMocks();
});

function call(secret?: { query?: string; bearer?: string }) {
	const url = new URL('http://localhost/api/cron');
	if (secret?.query !== undefined) url.searchParams.set('secret', secret.query);
	const headers: Record<string, string> = {};
	if (secret?.bearer !== undefined) headers.authorization = `Bearer ${secret.bearer}`;
	return GET({ url, request: new Request(url, { headers }) } as never);
}

test('rejects a request with no secret at all', async () => {
	await expect(call()).rejects.toThrowError(expect.objectContaining({ status: 401 }));
});

test('rejects a wrong secret in both query and header', async () => {
	await expect(call({ query: 'wrong' })).rejects.toThrowError(expect.objectContaining({ status: 401 }));
	await expect(call({ bearer: 'wrong' })).rejects.toThrowError(expect.objectContaining({ status: 401 }));
});

test('rejects length-mismatched secrets without throwing a 500', async () => {
	await expect(call({ bearer: 'x' })).rejects.toThrowError(expect.objectContaining({ status: 401 }));
	await expect(call({ bearer: 'test-secret-but-longer' })).rejects.toThrowError(expect.objectContaining({ status: 401 }));
	await expect(call({ bearer: 'test-secrex' })).rejects.toThrowError(expect.objectContaining({ status: 401 }));
});

test('fails loudly when CRON_SECRET is not configured', async () => {
	delete mocks.env.CRON_SECRET;

	await expect(call({ bearer: 'anything' })).rejects.toThrowError(expect.objectContaining({ status: 500 }));
});

test('rejects a malformed Authorization header even with a valid query secret', async () => {
	const url = new URL('http://localhost/api/cron?secret=test-secret');
	const request = new Request(url, { headers: { authorization: 'Basic anything' } });

	await expect(GET({ url, request } as never)).rejects.toThrowError(
		expect.objectContaining({ status: 401 })
	);
});

test.each([
	{ label: 'plan-documented query secret for manual triggers', secret: { query: 'test-secret' } },
	{ label: 'Authorization bearer secret without a query param', secret: { bearer: 'test-secret' } }
])('accepts the $label', async ({ secret }) => {
	const res = await call(secret);

	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({ ok: true, results: {} });
});

test('runs the channel with a server-side deadline inside the caller abort window', async () => {
	await testDb().db.insert(channels).values({ id: 'UC1', title: 'One', refreshTokenEnc: 'enc' });
	const before = Date.now();

	await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).toHaveBeenCalledWith('UC1', expect.objectContaining({
		// The scheduled function aborts at 25s; the server must stop before that.
		deadline: expect.any(Number)
	}));
	const deadline = mocks.runChannel.mock.calls[0][1].deadline;
	expect(deadline - before).toBeGreaterThanOrEqual(19_000);
	expect(deadline - before).toBeLessThanOrEqual(21_000);
});
