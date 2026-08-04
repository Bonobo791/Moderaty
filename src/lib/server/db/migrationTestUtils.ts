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

import { readFileSync } from 'node:fs';

import { createClient, type Client } from '@libsql/client';
import { expect } from 'vitest';

/**
 * Loads a drizzle migration SQL file and splits it into executable
 * statements: split on the `--> statement-breakpoint` marker, strip `--`
 * comment lines, drop empties. Shared by the migration behavior tests.
 *
 * @param file - The migration file name inside `drizzle/` (e.g. `0013_channels_org_contract.sql`)
 * @returns The migration's statements in execution order
 */
export function migrationStatements(file: string): string[] {
	const migration = readFileSync(new URL(`../../../../drizzle/${file}`, import.meta.url), 'utf8');
	return migration
		.split('--> statement-breakpoint')
		.map((chunk) =>
			chunk
				.split('\n')
				.filter((line) => !line.trimStart().startsWith('--'))
				.join('\n')
				.trim()
		)
		.filter((chunk) => chunk.length > 0);
}

// Every client opened via applyMigration is tracked here so
// closeMigratedDbs can close them all — even when an assertion fails
// mid-test. Register `afterEach(closeMigratedDbs)` in each test file.
const openClients: Client[] = [];

/**
 * Builds an in-memory database at a migration's pre-state (DDL plus optional
 * seed), applies the named migration's statements in order, and returns the
 * open client. The client is tracked for closeMigratedDbs.
 *
 * @param preDdl - DDL (plus indexes) for the pre-migration schema shape
 * @param migrationFile - The migration file name inside `drizzle/`
 * @param seedSql - Optional seed statements executed after the DDL
 * @returns The open, migrated in-memory client
 */
export async function applyMigration(preDdl: string, migrationFile: string, seedSql = ''): Promise<Client> {
	const client = createClient({ url: ':memory:' });
	openClients.push(client);
	await client.execute('PRAGMA foreign_keys = ON');
	await client.executeMultiple(preDdl + seedSql);
	for (const statement of migrationStatements(migrationFile)) await client.execute(statement);
	return client;
}

/**
 * Closes every client opened via applyMigration. Pass to vitest's afterEach.
 */
export function closeMigratedDbs(): void {
	for (const client of openClients.splice(0)) client.close();
}

/**
 * Asserts the channels_org_requires_owner tenancy contract rejects an owned
 * channel with no org. Re-run after every channels migration so a rebuild
 * that drops the CHECK cannot slip through.
 *
 * @param client - A migrated in-memory client from applyMigration
 */
export async function expectTenancyContract(client: Client): Promise<void> {
	await expect(
		client.execute(
			"INSERT INTO channels (id, user_id, title, refresh_token_enc) VALUES ('UCbad', 'user-1', 'Bad', 'enc-b')"
		)
	).rejects.toThrow(/channels_org_requires_owner/);
}
