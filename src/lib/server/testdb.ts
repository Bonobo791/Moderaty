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

export async function createTestDb(): Promise<TestDb> {
	const client = createClient({ url: ':memory:' });
	await client.batch([
		`CREATE TABLE channels (
			id TEXT PRIMARY KEY,
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
			author_channel_id TEXT NOT NULL,
			author_name TEXT NOT NULL,
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
		)`
	]);
	return { db: drizzle(client, { schema }), client };
}
