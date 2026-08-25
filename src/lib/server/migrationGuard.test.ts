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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { setupTestDb, testDb } from '$lib/server/testdb';
import journal from '../../../drizzle/meta/_journal.json';

// Flippable so one test can run the guard as it behaves during `vite build`
// (prerender has no database) while every other test runs it as runtime code.
const environmentMock = vi.hoisted(() => ({ building: false }));
vi.mock('$app/environment', () => ({
	get building() {
		return environmentMock.building;
	}
}));

// The expected count must come from the real journal — never hardcode it,
// or this test silently rots the next time a migration lands.
const expected = (journal as { entries: unknown[] }).entries.length;

// setupTestDb's schema has no __drizzle_migrations (the real one is created
// by drizzle-kit itself), so the guard's table is created here. The wipe list
// keeps each test's applied-count isolated.
setupTestDb(['__drizzle_migrations']);

beforeAll(async () => {
	await testDb().client.execute(
		'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)'
	);
});

beforeEach(() => {
	// spyOn re-uses the existing spy, so clear the accumulated call history
	// or "not.toHaveBeenCalled" sees earlier tests' logs.
	vi.spyOn(console, 'error').mockImplementation(() => {}).mockClear();
});

afterEach(() => {
	environmentMock.building = false;
});

async function freshGuard(): Promise<{ assertMigrationsCurrent: () => Promise<void> }> {
	// The success cache is module state — reset so every test starts cold.
	vi.resetModules();
	return await import('./migrationGuard');
}

async function seedAppliedMigrations(count: number): Promise<void> {
	await testDb().client.batch(
		Array.from({ length: count }, (_, i) => ({
			sql: 'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
			args: [`hash-${i}`, i]
		}))
	);
}

function loggedCounts(): string {
	return vi
		.mocked(console.error)
		.mock.calls.map((call) => String(call[0]))
		.join('\n');
}

test('a current database passes, and the success is cached for the process', async () => {
	await seedAppliedMigrations(expected);
	const guard = await freshGuard();

	await expect(guard.assertMigrationsCurrent()).resolves.toBeUndefined();

	// Wipe the table: a re-query would now see 0/expected and fail. A second
	// call must NOT re-query — a warm instance stays fast.
	await testDb().client.execute('DELETE FROM __drizzle_migrations');
	await expect(guard.assertMigrationsCurrent()).resolves.toBeUndefined();
	expect(console.error).not.toHaveBeenCalled();
});

test('a database behind the code fails loudly with a 503 and logs the actionable counts', async () => {
	await seedAppliedMigrations(expected - 1);
	const guard = await freshGuard();

	// The client-facing message is part of the contract: generic retry copy,
	// never the operational detail (that goes to the server log only).
	await expect(guard.assertMigrationsCurrent()).rejects.toMatchObject({
		status: 503,
		body: { message: 'the service is being upgraded — please retry in a few minutes' }
	});
	expect(loggedCounts()).toContain(`${expected - 1}/${expected}`);
	expect(loggedCounts()).toContain('db:migrate');
});

test('during prerendering the guard is a no-op — the build has no database', async () => {
	environmentMock.building = true;
	// Behind the code AND unqueryable: any check at all would fail here.
	const getSpy = vi.spyOn(testDb().db, 'get');
	const guard = await freshGuard();

	await expect(guard.assertMigrationsCurrent()).resolves.toBeUndefined();

	expect(getSpy).not.toHaveBeenCalled();
	expect(console.error).not.toHaveBeenCalled();
	getSpy.mockRestore();
});

test('an empty migration count result reads as 0 applied, not a crash', async () => {
	// db.get resolves undefined when the query yields no row (drizzle
	// contract); the guard must treat that as 0/expected, i.e. a loud 503,
	// not a TypeError leaking out of the request boundary.
	const getSpy = vi
		.spyOn(testDb().db, 'get')
		.mockResolvedValue(undefined as unknown as { n: number });
	const guard = await freshGuard();
	try {
		await expect(guard.assertMigrationsCurrent()).rejects.toMatchObject({
			status: 503,
			body: { message: 'the service is being upgraded — please retry in a few minutes' }
		});
		expect(loggedCounts()).toContain(`0/${expected}`);
	} finally {
		getSpy.mockRestore();
	}
});

test('the failure is not cached — the guard recovers as soon as the human migrates', async () => {
	await seedAppliedMigrations(expected - 1);
	const guard = await freshGuard();
	await expect(guard.assertMigrationsCurrent()).rejects.toMatchObject({ status: 503 });

	// The human applies the pending migration out-of-band; the next request
	// re-checks and passes without a redeploy.
	await seedAppliedMigrations(1);
	await expect(guard.assertMigrationsCurrent()).resolves.toBeUndefined();
});

test('a database ahead of the code passes (expand-migrate-contract is safe that way)', async () => {
	await seedAppliedMigrations(expected + 1);
	const guard = await freshGuard();

	await expect(guard.assertMigrationsCurrent()).resolves.toBeUndefined();
	expect(console.error).not.toHaveBeenCalled();
});

test('concurrent cold-start requests share a single migration check', async () => {
	await seedAppliedMigrations(expected);
	const guard = await freshGuard();

	// Count the queries that actually reach libsql: eight concurrent calls
	// racing a cold cache must collapse into ONE check, not eight.
	const client = testDb().client;
	const originalExecute = client.execute.bind(client);
	let queries = 0;
	client.execute = ((...args: Parameters<typeof client.execute>) => {
		queries++;
		return originalExecute(...args);
	}) as typeof client.execute;
	try {
		await Promise.all(Array.from({ length: 8 }, () => guard.assertMigrationsCurrent()));
	} finally {
		client.execute = originalExecute;
	}
	expect(queries).toBe(1);
});
