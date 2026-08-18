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

// Test helper: real in-memory libsql database with the app schema.
// Never imported by app code — tests only.

import { createClient, type Client } from '@libsql/client';
import { getTableName, is } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { beforeAll, beforeEach, vi } from 'vitest';
import * as schema from './db/schema';
import { consents, users } from './db/schema';

export interface TestDb {
	db: LibSQLDatabase<typeof schema>;
	client: Client;
}

const holder: { current: TestDb | null } = { current: null };

// Every test file that imports this helper gets the app db mocked onto the
// shared in-memory instance. This module is always imported before the
// route-under-test, so the mock is registered before $lib/server/db loads.
vi.mock('$lib/server/db', () => ({
	get db() {
		return testDb().db;
	}
}));

/**
 * Deletes every row from the given tables. Used per-test by setupTestDb and
 * per-property-run by property tests (a single property runs ~100 predicates
 * inside one test, so state must be wiped inside the predicate too).
 *
 * Table names are interpolated into SQL, so they are validated against the
 * app schema first — a typo or a non-app table (e.g. sqlite_sequence) fails
 * loudly instead of wiping the wrong thing. FK enforcement is suspended for
 * the wipe so callers never have to order tables around FK dependencies;
 * the pragma only takes effect outside a transaction, which is why this
 * uses executeMultiple rather than the transactional batch().
 */
export async function wipeTables(tables: string[]): Promise<void> {
	for (const table of tables) {
		if (!WIPEABLE_TABLES.has(table)) {
			throw new Error(`wipeTables: unknown table "${table}" (not in the app schema)`);
		}
	}
	const statements = ['PRAGMA foreign_keys = OFF', ...tables.map((table) => `DELETE FROM ${table}`)];
	try {
		await testDb().client.executeMultiple(statements.join(';\n'));
	} finally {
		// The ON cannot travel inside the multiple: executeMultiple stops at the
		// first failing statement, so a failed DELETE would leave the shared
		// connection with FK enforcement OFF for every later test.
		await testDb().client.execute('PRAGMA foreign_keys = ON');
	}
}

// Derived from the Drizzle schema so the allowlist can never drift from the
// real table set (relations and type exports are filtered out).
// __drizzle_migrations is not in the schema — drizzle-kit owns it — but the
// migration guard reads it, so its tests must be able to wipe it.
const WIPEABLE_TABLES: Set<string> = new Set([
	...Object.values(schema)
		.filter((value) => is(value, SQLiteTable))
		.map((table) => getTableName(table)),
	'__drizzle_migrations'
]);

/**
 * Registers beforeAll/beforeEach hooks that create the in-memory db and wipe
 * the given tables before each test. File-local beforeEach hooks registered
 * after this call run after the cleanup.
 */
export function setupTestDb(tables: string[]): void {
	beforeAll(async () => {
		holder.current = await createTestDb();
	});
	beforeEach(async () => {
		await wipeTables(tables);
	});
}

export function testDb(): TestDb {
	if (!holder.current) throw new Error('test db not initialized — call setupTestDb() first');
	return holder.current;
}

export function postForm(fields: Record<string, string>, url = 'http://localhost/'): Request {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return new Request(url, { method: 'POST', body: form });
}

export const DAY_MS = 24 * 60 * 60 * 1000;

// Re-exported so test files can take fixtures and db helpers from one place;
// the fixture itself lives in the side-effect-free testuser.ts.
export { TEST_OWNER } from './testuser';

/** Seeds a bare user row with a synthetic identity. */
export async function seedUser(id: string): Promise<string> {
	await testDb().db.insert(users).values({ id, googleSub: `sub-${id}`, email: `${id}@example.com`, displayName: id });
	return id;
}

/** Seeds a consent record for an existing user with the e-mail retained (synthetic evidence values). */
export async function seedConsent(userId: string, createdAt?: string, docVersion = 'v1.2'): Promise<void> {
	await testDb().db.insert(consents).values({
		userId,
		email: `${userId}@example.com`,
		docVersion,
		checkboxText: 'I agree',
		ip: '127.0.0.1',
		userAgent: 'test',
		...(createdAt ? { createdAt } : {})
	});
}

/**
 * Creates an in-memory test database with the application schema and foreign-key enforcement enabled.
 *
 * @returns The initialized database and its underlying libSQL client
 */
export async function createTestDb(): Promise<TestDb> {
	const client = createClient({ url: 'file::memory:?cache=shared' });
	// Match production Turso behavior so FK violations fail in tests too.
	await client.execute('PRAGMA foreign_keys = ON');
	await client.batch([
		`CREATE TABLE users (
			id TEXT PRIMARY KEY,
			google_sub TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL,
			display_name TEXT NOT NULL,
			plan TEXT NOT NULL DEFAULT 'free',
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			active_org_id TEXT,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE TABLE channels (
			id TEXT PRIMARY KEY,
			user_id TEXT,
			org_id TEXT,
			title TEXT NOT NULL,
			refresh_token_enc TEXT NOT NULL,
			cursor TEXT,
			next_page_token TEXT,
			scan_cursor TEXT,
			history_next_page_token TEXT,
			history_boundary TEXT,
			dry_run_boundary TEXT,
			dry_run_page_token TEXT,
			last_run_at TEXT,
			lease_expires_at TEXT,
			active INTEGER NOT NULL DEFAULT 1,
			tone_level INTEGER,
			protect_lgbtqia INTEGER NOT NULL DEFAULT 0,
			protect_women INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			CONSTRAINT channels_org_requires_owner CHECK (org_id IS NOT NULL OR user_id IS NULL)
		)`,
		`CREATE TABLE rules (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			channel_id TEXT NOT NULL,
			type TEXT NOT NULL,
			pattern TEXT NOT NULL,
			action TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE TABLE channel_allowed_handles (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			channel_id TEXT NOT NULL,
			handle TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE INDEX channel_allowed_handles_channel_idx ON channel_allowed_handles (channel_id)`,
		`CREATE TABLE comments (
			id TEXT PRIMARY KEY,
			channel_id TEXT NOT NULL,
			author_channel_id TEXT,
			author_name TEXT,
			text TEXT NOT NULL,
			published_at TEXT NOT NULL,
			status TEXT NOT NULL,
			decided_by TEXT NOT NULL,
			matched_rule_id INTEGER,
			ai_score TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE TABLE audit_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			channel_id TEXT NOT NULL,
			comment_id TEXT NOT NULL,
			action TEXT NOT NULL,
			reason TEXT NOT NULL,
			actor TEXT NOT NULL,
			text TEXT,
			author_handle TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE TABLE moderation_actions (
			comment_id TEXT PRIMARY KEY,
			channel_id TEXT NOT NULL,
			action TEXT NOT NULL,
			reason TEXT NOT NULL,
			state TEXT NOT NULL,
			last_attempt_at TEXT,
			last_manual_retry_at TEXT,
			author_handle TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE TABLE consents (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			email TEXT,
			doc_version TEXT NOT NULL,
			checkbox_text TEXT NOT NULL,
			ip TEXT NOT NULL,
			user_agent TEXT NOT NULL,
			marketing_opt_in INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE INDEX consents_email_retention_idx ON consents (created_at) WHERE email IS NOT NULL`,
		`CREATE TABLE organizations (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			plan TEXT NOT NULL DEFAULT 'free',
			personal_for TEXT,
			openai_key_enc TEXT,
			credits_remaining INTEGER,
			stripe_customer_id TEXT,
			stripe_default_pm_id TEXT,
			auto_topup_enabled INTEGER,
			auto_topup_threshold INTEGER,
			auto_topup_state TEXT,
			auto_topup_last_attempt_at TEXT,
			auto_topup_failures INTEGER,
			auto_topup_consent_text TEXT,
			auto_topup_consent_version TEXT,
			auto_topup_consented_by TEXT,
			auto_topup_consented_at TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE TABLE credit_transactions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			delta INTEGER NOT NULL,
			reason TEXT NOT NULL,
			ref_type TEXT NOT NULL,
			ref_id TEXT NOT NULL,
			payment_intent_id TEXT,
			charge_id TEXT,
			balance_after INTEGER,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE UNIQUE INDEX credit_transactions_org_ref_idx ON credit_transactions (org_id, ref_type, ref_id)`,
		`CREATE INDEX credit_transactions_org_created_idx ON credit_transactions (org_id, created_at)`,
		`CREATE INDEX credit_transactions_pi_idx ON credit_transactions (payment_intent_id)`,
		`CREATE INDEX credit_transactions_charge_idx ON credit_transactions (charge_id)`,
		`CREATE TABLE stripe_pending_reversals (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			charge_id TEXT NOT NULL UNIQUE,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE TABLE stripe_deletion_outbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			customer_id TEXT NOT NULL UNIQUE,
			attempts INTEGER NOT NULL DEFAULT 0,
			last_attempt_at TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE TABLE stripe_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT NOT NULL UNIQUE,
			event_type TEXT NOT NULL,
			object_id TEXT NOT NULL,
			object_type TEXT NOT NULL,
			received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			processed_at TEXT
		)`,
		`CREATE UNIQUE INDEX stripe_events_type_object_idx ON stripe_events (event_type, object_id)`,
		`CREATE UNIQUE INDEX organizations_personal_for_unique ON organizations (personal_for)`,
		`CREATE TABLE memberships (
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			role TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			PRIMARY KEY (user_id, org_id)
		)`,
		`CREATE TABLE contact_submissions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL,
			name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			verification_token TEXT NOT NULL UNIQUE,
			expires_at TEXT NOT NULL,
			verified_at TEXT,
			consent_text TEXT NOT NULL,
			ip TEXT NOT NULL,
			user_agent TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE INDEX contact_submissions_status_email_idx ON contact_submissions (status, email)`,
		`CREATE TABLE invites (
			token TEXT PRIMARY KEY,
			org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			role TEXT NOT NULL,
			created_by TEXT NOT NULL REFERENCES users(id),
			expires_at TEXT NOT NULL,
			accepted_by TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`
	]);
	return { db: drizzle(client, { schema }), client };
}
