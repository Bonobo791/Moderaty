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

import { afterEach, expect, test, vi } from 'vitest';

import {
	applyMigration,
	closeMigratedDbs,
	expectTenancyContract,
	migrationStatements
} from './migrationTestUtils';

// migrationStatements reads via readFileSync(new URL(`../../../../drizzle/${file}`)).
// To exercise the statement-splitting contract (comment stripping, empty-chunk
// dropping, multi-line joins) against inputs no current drizzle file provides,
// readFileSync is mocked with a per-test override; null falls through to the
// real filesystem so every other test reads the real migrations.
const fakeSql = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('node:fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs')>();
	return {
		...original,
		readFileSync: (...args: Parameters<typeof original.readFileSync>) =>
			fakeSql.value === null ? original.readFileSync(...args) : fakeSql.value
	};
});

afterEach(() => {
	fakeSql.value = null;
});
afterEach(closeMigratedDbs);

// The pre-0013 channels shape (final 0012 shape): org_id present, NO
// channels_org_requires_owner CHECK — the shape the contract is added on top
// of. All 13 columns are required because 0013's copy statement selects them.
const CHANNELS_NO_CONTRACT_DDL = `
	CREATE TABLE channels (
		id TEXT PRIMARY KEY,
		user_id TEXT,
		org_id TEXT,
		title TEXT NOT NULL,
		refresh_token_enc TEXT NOT NULL,
		cursor TEXT,
		next_page_token TEXT,
		scan_cursor TEXT,
		last_run_at TEXT,
		lease_expires_at TEXT,
		active INTEGER NOT NULL DEFAULT 1,
		tone_level INTEGER,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
`;

test('migrationStatements splits on breakpoints and strips license/comment lines', () => {
	// 0010 carries the full license header before its single statement
	// and no breakpoints: one chunk whose comment lines must all be gone.
	expect(migrationStatements('0010_users_deleted_at_idx.sql')).toEqual([
		'CREATE INDEX `users_deleted_at_idx` ON `users` (`deleted_at`);'
	]);
});

test('migrationStatements returns 0013 in execution order, with retry-guard comments stripped', () => {
	const statements = migrationStatements('0013_channels_org_contract.sql');
	expect(statements).toHaveLength(9);
	expect(statements[0]).toBe('PRAGMA foreign_keys=OFF;');
	expect(statements[1]).toBe('DROP TABLE IF EXISTS `__new_channels`;');
	expect(statements[4]).toBe('DROP TABLE `channels`;');
	expect(statements[5]).toBe('ALTER TABLE `__new_channels` RENAME TO `channels`;');
	expect(statements[6]).toBe('PRAGMA foreign_keys=ON;');
	expect(statements[7]).toBe('CREATE INDEX `channels_user_id_idx` ON `channels` (`user_id`);');
	expect(statements[8]).toBe('CREATE INDEX `channels_org_id_idx` ON `channels` (`org_id`);');
	// No statement may retain a comment line or be empty/whitespace.
	for (const statement of statements) {
		expect(statement.length).toBeGreaterThan(0);
		for (const line of statement.split('\n')) {
			expect(line.trimStart().startsWith('--')).toBe(false);
		}
	}
});

test('migrationStatements preserves multi-line statement text exactly (0013 CREATE TABLE)', () => {
	const statements = migrationStatements('0013_channels_org_contract.sql');
	// Exact text matters: joining lines with '' instead of '\n' must fail here.
	expect(statements[2]).toBe(
		'CREATE TABLE `__new_channels` (\n' +
			'\t`id` text PRIMARY KEY NOT NULL,\n' +
			'\t`user_id` text,\n' +
			'\t`org_id` text,\n' +
			'\t`title` text NOT NULL,\n' +
			'\t`refresh_token_enc` text NOT NULL,\n' +
			'\t`cursor` text,\n' +
			'\t`next_page_token` text,\n' +
			'\t`scan_cursor` text,\n' +
			'\t`last_run_at` text,\n' +
			'\t`lease_expires_at` text,\n' +
			'\t`active` integer DEFAULT 1 NOT NULL,\n' +
			'\t`tone_level` integer,\n' +
			"\t`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,\n" +
			'\tCONSTRAINT "channels_org_requires_owner" CHECK("__new_channels"."org_id" IS NOT NULL OR "__new_channels"."user_id" IS NULL)\n' +
			');'
	);
	expect(statements[3]).toBe(
		'INSERT INTO `__new_channels`("id", "user_id", "org_id", "title", "refresh_token_enc", "cursor", "next_page_token", "scan_cursor", "last_run_at", "lease_expires_at", "active", "tone_level", "created_at")' +
			' SELECT "id", "user_id", "org_id", "title", "refresh_token_enc", "cursor", "next_page_token", "scan_cursor", "last_run_at", "lease_expires_at", "active", "tone_level", "created_at" FROM `channels`;'
	);
});

test('migrationStatements drops chunks that are empty after comment stripping', () => {
	// No current drizzle file has a comment-only chunk between breakpoints
	// (verified across 0000–0018), so this contract case uses a synthetic file:
	// an empty first chunk, a comment-only middle chunk, and a multi-line
	// statement whose internal newlines must survive.
	fakeSql.value = [
		'-- license header only, no statement in this chunk',
		'--> statement-breakpoint',
		'CREATE TABLE a (',
		'\tid TEXT PRIMARY KEY',
		');',
		'--> statement-breakpoint',
		'-- explanation comment',
		'-- spanning two lines',
		'--> statement-breakpoint',
		"INSERT INTO a VALUES ('x');",
		'  -- indented trailing comment (leading whitespace must not save it)',
		'\t-- tab-indented comment'
	].join('\n');
	expect(migrationStatements('0000_synthetic.sql')).toEqual([
		'CREATE TABLE a (\n\tid TEXT PRIMARY KEY\n);',
		"INSERT INTO a VALUES ('x');"
	]);
});

test('applyMigration runs DDL, seed, and migration in order with foreign keys ON', async () => {
	const client = await applyMigration(
		CHANNELS_NO_CONTRACT_DDL,
		'0013_channels_org_contract.sql',
		"INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc) VALUES ('UC1', 'user-1', 'org-1', 'T', 'enc');"
	);
	// Seed ran before the rebuild and survived it.
	const { rows } = await client.execute('SELECT id, org_id FROM channels');
	expect(rows).toEqual([{ id: 'UC1', org_id: 'org-1' }]);
	// The migration actually applied: the contract now bites.
	await expect(
		client.execute("INSERT INTO channels (id, user_id, title, refresh_token_enc) VALUES ('UCbad', 'user-1', 'B', 'e')")
	).rejects.toThrow(/channels_org_requires_owner/);
	// FK enforcement is on (applyMigration's PRAGMA, not a libsql default).
	const fk = await client.execute('PRAGMA foreign_keys');
	expect(fk.rows[0].foreign_keys).toBe(1);
});

test('closeMigratedDbs closes every tracked client and is idempotent', async () => {
	const first = await applyMigration(CHANNELS_NO_CONTRACT_DDL, '0013_channels_org_contract.sql');
	const second = await applyMigration(CHANNELS_NO_CONTRACT_DDL, '0013_channels_org_contract.sql');
	closeMigratedDbs();
	await expect(first.execute('SELECT 1')).rejects.toThrow(/CLIENT_CLOSED/);
	await expect(second.execute('SELECT 1')).rejects.toThrow(/CLIENT_CLOSED/);
	// The tracking list was drained: a second close is a no-op, not an error,
	// and a client opened afterwards stays open.
	expect(() => closeMigratedDbs()).not.toThrow();
	const third = await applyMigration(CHANNELS_NO_CONTRACT_DDL, '0013_channels_org_contract.sql');
	await expect(third.execute('SELECT 1')).resolves.toBeDefined();
});

test('expectTenancyContract passes on a contracted database', async () => {
	const client = await applyMigration(CHANNELS_NO_CONTRACT_DDL, '0013_channels_org_contract.sql');
	await expectTenancyContract(client);
	// The probe INSERT was rejected, so no UCbad row leaked in.
	const { rows } = await client.execute("SELECT count(*) AS c FROM channels WHERE id = 'UCbad'");
	expect(rows[0].c).toBe(0);
});

test('expectTenancyContract fails loudly when the contract is missing', async () => {
	// Channels WITHOUT the CHECK (0016 only adds an audit_log index): the probe
	// INSERT succeeds, so the helper must report the missing contract, not
	// silently pass.
	const client = await applyMigration(
		`${CHANNELS_NO_CONTRACT_DDL}CREATE TABLE audit_log (id TEXT PRIMARY KEY, channel_id TEXT, action TEXT);`,
		'0016_audit_log_channel_action_idx.sql'
	);
	await expect(expectTenancyContract(client)).rejects.toThrow();
});
