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

import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { setupTestDb, testDb } from '$lib/server/testdb';
import journal from '../../../drizzle/meta/_journal.json';

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

	await expect(guard.assertMigrationsCurrent()).rejects.toMatchObject({ status: 503 });
	expect(loggedCounts()).toContain(`${expected - 1}/${expected}`);
	expect(loggedCounts()).toContain('db:migrate');
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
