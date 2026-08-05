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
import { GET } from './+server';

setupTestDb([]);

beforeEach(() => {
	vi.spyOn(console, 'error').mockImplementation(() => {}).mockClear();
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
		await expect(GET({} as never)).rejects.toMatchObject({ status: 503 });
	} finally {
		client.execute = originalExecute;
	}

	expect(console.error).toHaveBeenCalled();
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
