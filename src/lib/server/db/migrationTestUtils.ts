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
