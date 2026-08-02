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

// Guard for the PR #40 review finding: the seed wrote comment-author PII
// (author_channel_id, author_name) into a table the project deliberately
// keeps author-free. 0008 relaxes those columns to nullable; the contract
// migration that drops them comes later, and any INSERT still naming them
// breaks the moment it lands.

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const SEED = new URL('./seed-dev.mjs', import.meta.url);
const DRIZZLE = new URL('../drizzle/', import.meta.url);

const tmp = mkdtempSync(join(tmpdir(), 'seed-dev-test-'));
const dbUrl = `file:${join(tmp, 'test.db')}`;

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

// Base tables predate migration tracking (they were created by drizzle-kit
// push before drizzle/0000); migrations only ALTER them or add new tables.
// This is the pre-0000 shape: channels without the columns 0000/0002/0006
// add, and comments before 0008 relaxes the author columns.
const BASE_DDL = `
CREATE TABLE channels (
	id text PRIMARY KEY NOT NULL,
	title text NOT NULL,
	refresh_token_enc text NOT NULL,
	cursor text,
	active integer NOT NULL DEFAULT 1,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE rules (
	id integer PRIMARY KEY AUTOINCREMENT,
	channel_id text NOT NULL,
	type text NOT NULL,
	pattern text NOT NULL,
	action text NOT NULL,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE comments (
	id text PRIMARY KEY NOT NULL,
	channel_id text NOT NULL,
	author_channel_id text,
	author_name text,
	text text NOT NULL,
	published_at text NOT NULL,
	status text NOT NULL,
	decided_by text NOT NULL,
	matched_rule_id integer,
	ai_score text,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE audit_log (
	id integer PRIMARY KEY AUTOINCREMENT,
	channel_id text NOT NULL,
	comment_id text NOT NULL,
	action text NOT NULL,
	reason text NOT NULL,
	actor text NOT NULL,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

async function applyMigrations(url) {
	const client = createClient({ url });
	for (const statement of BASE_DDL.split(';')) {
		const trimmed = statement.trim();
		if (trimmed) await client.execute(trimmed);
	}
	const files = readdirSync(DRIZZLE)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const file of files) {
		const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
		for (const statement of sql.split('--> statement-breakpoint')) {
			const trimmed = statement.trim();
			if (trimmed) await client.execute(trimmed);
		}
	}
	client.close();
}

describe('seed-dev comment author PII (PR #40 review)', () => {
	it('the comments INSERT never names the author columns', () => {
		const source = readFileSync(SEED, 'utf8');
		const insert = source.match(/INSERT INTO comments[^`]*`/s);
		expect(insert, 'seed-dev.mjs must contain a comments INSERT').not.toBeNull();
		expect(insert[0]).not.toMatch(/author_channel_id|author_name/);
	});

	it('runs clean against the fully migrated schema and seeds NULL author identifiers', async () => {
		await applyMigrations(dbUrl);
		const { stdout } = await execFileAsync('node', [SEED.pathname], {
			env: { ...process.env, TURSO_DATABASE_URL: dbUrl }
		});
		expect(stdout).toMatch(/seed|done|insert/i);

		const client = createClient({ url: dbUrl });
		const rows = await client.execute(
			"SELECT author_channel_id, author_name FROM comments WHERE channel_id = 'seed-UC-night-shift'"
		);
		client.close();
		expect(rows.rows.length).toBeGreaterThan(0);
		for (const row of rows.rows) {
			expect(row.author_channel_id).toBeNull();
			expect(row.author_name).toBeNull();
		}
	}, 20000);
});
