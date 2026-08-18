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

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setupTestDb, testDb } from '$lib/server/testdb';
import { GET } from './+server';

setupTestDb([]);

beforeEach(() => {
	vi.spyOn(console, 'error').mockImplementation(() => {}).mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

test('a healthy database answers 200 with a bare ok status', async () => {
	const res = await GET({} as never);

	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ status: 'ok' });
});

test('a database failure answers 503 with a generic body and logs the real error server-side', async () => {
	const client = testDb().client;
	const originalExecute = client.execute.bind(client);
	client.execute = (() => Promise.reject(new Error('hrana 502: connect to upstream failed'))) as never;
	try {
		await expect(GET({} as never)).rejects.toMatchObject({
			status: 503,
			body: { message: 'the service is temporarily unavailable — please retry shortly' }
		});
	} finally {
		client.execute = originalExecute;
	}

	expect(console.error).toHaveBeenCalledWith(
		'health check database query failed:',
		expect.any(Error)
	);
	// Drizzle wraps driver errors; the real outage detail rides the cause chain.
	const loggedError = vi.mocked(console.error).mock.calls[0][1] as Error;
	expect(loggedError).toBeInstanceOf(Error);
	expect((loggedError.cause as Error).message).toContain('connect to upstream failed');
});

test('the failure response never leaks driver detail to the client', async () => {
	const client = testDb().client;
	const originalExecute = client.execute.bind(client);
	client.execute = (() => Promise.reject(new Error('hrana 502: connect to upstream failed'))) as never;
	let thrown: unknown;
	try {
		await GET({} as never);
	} catch (e) {
		thrown = e;
	} finally {
		client.execute = originalExecute;
	}

	// The whole serialized error must not contain the driver message or any URL.
	const serialized = JSON.stringify(thrown);
	expect(serialized).not.toContain('hrana');
	expect(serialized).not.toContain('upstream');
	expect(serialized).not.toContain('libsql://');
});
