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
import { createClient } from '@libsql/client';
import { expect, test } from 'vitest';

// Behavior test for migration 0009 (account deletion v2): applied to a
// PRE-change database (consents without an email column), it must add the
// nullable column and backfill it from the owning user, so account deletion
// can wipe users.email while the consent evidence keeps it (Art. 16, III).
const migration = readFileSync(new URL('../../../../drizzle/0009_consents_email.sql', import.meta.url), 'utf8');
const statements = migration
	.split('--> statement-breakpoint')
	.map((chunk) =>
		chunk
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('--'))
			.join('\n')
			.trim()
	)
	.filter((chunk) => chunk.length > 0);

async function migratedDb() {
	const client = createClient({ url: ':memory:' });
	// The pre-0009 shape: users with live e-mails, consents without the column.
	await client.executeMultiple(`
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			google_sub TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL,
			display_name TEXT NOT NULL,
			plan TEXT NOT NULL DEFAULT 'free',
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE TABLE consents (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			doc_version TEXT NOT NULL,
			checkbox_text TEXT NOT NULL,
			ip TEXT NOT NULL,
			user_agent TEXT NOT NULL,
			marketing_opt_in INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		INSERT INTO users (id, google_sub, email, display_name)
		VALUES ('user-1', 'sub-1', 'one@example.com', 'One');
		INSERT INTO consents (user_id, doc_version, checkbox_text, ip, user_agent)
		VALUES ('user-1', 'v1.2', 'I agree', '127.0.0.1', 'test');
	`);
	for (const statement of statements) await client.execute(statement);
	return client;
}

test('migration 0009 adds the email column and backfills it from the owning user', async () => {
	const client = await migratedDb();
	const { rows } = await client.execute('SELECT * FROM consents');
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		user_id: 'user-1',
		email: 'one@example.com',
		doc_version: 'v1.2',
		checkbox_text: 'I agree'
	});
});

test('post-migration schema accepts inserts with and without the email column', async () => {
	const client = await migratedDb();
	await client.execute({
		sql: `INSERT INTO consents (user_id, email, doc_version, checkbox_text, ip, user_agent)
			VALUES ('user-1', 'one@example.com', 'v1.3', 'I agree', '127.0.0.1', 'test')`
	});
	await client.execute({
		// Old code inserting without the column still works (nullable, expand-only).
		sql: `INSERT INTO consents (user_id, doc_version, checkbox_text, ip, user_agent)
			VALUES ('user-1', 'v1.2', 'I agree', '127.0.0.1', 'test')`
	});
	const { rows } = await client.execute('SELECT email FROM consents ORDER BY id');
	expect(rows.map((row) => row.email)).toEqual(['one@example.com', 'one@example.com', null]);
});
