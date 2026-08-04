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
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
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
 * Registers beforeAll/beforeEach hooks that create the in-memory db and wipe
 * the given tables before each test. File-local beforeEach hooks registered
 * after this call run after the cleanup.
 */
export function setupTestDb(tables: string[]): void {
	beforeAll(async () => {
		holder.current = await createTestDb();
	});
	beforeEach(async () => {
		await testDb().client.batch(tables.map((table) => `DELETE FROM ${table}`));
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
			last_run_at TEXT,
			lease_expires_at TEXT,
			active INTEGER NOT NULL DEFAULT 1,
			tone_level INTEGER,
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
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE UNIQUE INDEX organizations_personal_for_unique ON organizations (personal_for)`,
		`CREATE TABLE memberships (
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			role TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			PRIMARY KEY (user_id, org_id)
		)`,
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
