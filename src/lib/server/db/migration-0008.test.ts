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

// Behavior test for migration 0008 (PR #40 review — expand/contract rollout):
// applied to a PRE-change database (NOT NULL author columns, stored author
// PII), it must relax the columns to nullable, wipe the stored identifiers,
// and preserve every other row and constraint.
const migration = readFileSync(new URL('../../../../drizzle/0008_relax_comment_author_pii.sql', import.meta.url), 'utf8');
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
	// The pre-0008 shape: author columns NOT NULL, with stored PII.
	await client.execute(`CREATE TABLE comments (
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
	)`);
	await client.execute({
		sql: `INSERT INTO comments (id, channel_id, author_channel_id, author_name, text, published_at, status, decided_by, matched_rule_id, ai_score, created_at)
			VALUES ('c1', 'UC1', 'UC-author', 'Ann', 'hello', '2026-01-01T00:00:00Z', 'pending', 'ai', 7, '0.60', '2025-12-31T23:59:59Z')`
	});
	for (const statement of statements) await client.execute(statement);
	return client;
}

test('migration 0008 preserves the comment rows but wipes stored author PII', async () => {
	const client = await migratedDb();
	const { rows } = await client.execute('SELECT * FROM comments');
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		id: 'c1',
		channel_id: 'UC1',
		text: 'hello',
		published_at: '2026-01-01T00:00:00Z',
		status: 'pending',
		decided_by: 'ai',
		matched_rule_id: 7,
		ai_score: '0.60',
		created_at: '2025-12-31T23:59:59Z',
		author_channel_id: null,
		author_name: null
	});
});

test('post-migration schema accepts inserts without author columns (new code path)', async () => {
	const client = await migratedDb();
	await client.execute({
		sql: `INSERT INTO comments (id, channel_id, text, published_at, status, decided_by)
			VALUES ('c2', 'UC1', 'new code', '2026-01-02T00:00:00Z', 'approved', 'ai')`
	});
	const { rows } = await client.execute(`SELECT author_channel_id, author_name FROM comments WHERE id = 'c2'`);
	expect(rows[0]).toMatchObject({ author_channel_id: null, author_name: null });
});

test('post-migration schema still rejects a missing comment text', async () => {
	const client = await migratedDb();
	await expect(
		client.execute({
			sql: `INSERT INTO comments (id, channel_id, published_at, status, decided_by)
				VALUES ('c3', 'UC1', '2026-01-02T00:00:00Z', 'approved', 'ai')`
		})
	).rejects.toThrow();
});
