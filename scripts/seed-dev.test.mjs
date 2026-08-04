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

describe('seed-dev multi-channel demo data', () => {
	const CHANNEL_IDS = ['seed-UC-night-shift', 'seed-UC-morning-show'];

	const runSeed = async (url, args = []) => {
		try {
			const { stdout } = await execFileAsync('node', [SEED.pathname, ...args], {
				env: { ...process.env, TURSO_DATABASE_URL: url }
			});
			return { code: 0, stdout };
		} catch (error) {
			return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
		}
	};

	const countFor = async (client, table, channelId) => {
		const column = table === 'channels' ? 'id' : 'channel_id';
		const r = await client.execute(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`, [channelId]);
		return r.rows[0].n;
	};

	it('seeds two orphan channels, each with its own rules, comments, and audit rows', async () => {
		const url = `file:${join(tmp, 'multi.db')}`;
		await applyMigrations(url);
		const { code, stdout, stderr } = await runSeed(url);
		expect(code, `seed must exit 0 (stderr: ${stderr})`).toBe(0);
		expect(stdout).toContain('seed-UC-night-shift');
		expect(stdout).toContain('seed-UC-morning-show');

		const client = createClient({ url });
		// Exact per-channel shape — toBeGreaterThan(0) would pass on a seed that
		// silently writes a third of the demo rows.
		const EXPECTED = { rules: 3, comments: 14, moderation_actions: 3, audit_log: 9 };
		for (const id of CHANNEL_IDS) {
			// Orphans: claimed into the first user's personal org on first login.
			const ch = await client.execute('SELECT user_id, org_id, active FROM channels WHERE id = ?', [id]);
			expect(ch.rows.length, `channel ${id} must be seeded`).toBe(1);
			expect(ch.rows[0].user_id).toBeNull();
			expect(ch.rows[0].org_id).toBeNull();
			// Inactive: demo rows must render in the UI, but cron must never burn
			// a run decrypting 'seed-not-a-real-token'.
			expect(ch.rows[0].active, `channel ${id} must be seeded inactive`).toBe(0);
			for (const table of ['rules', 'comments', 'moderation_actions', 'audit_log']) {
				expect(await countFor(client, table, id), `${table} rows for ${id}`).toBe(EXPECTED[table]);
			}
		}
		// Comment ids are per-channel prefixed and globally unique (primary key).
		const night = await client.execute("SELECT id FROM comments WHERE channel_id = 'seed-UC-night-shift'");
		const morning = await client.execute("SELECT id FROM comments WHERE channel_id = 'seed-UC-morning-show'");
		for (const row of night.rows) expect(row.id).toMatch(/^seed-comment-/);
		for (const row of morning.rows) expect(row.id).toMatch(/^seed-morning-comment-/);
		const dupes = await client.execute(
			'SELECT id FROM comments GROUP BY id HAVING count(*) > 1'
		);
		client.close();
		expect(dupes.rows).toHaveLength(0);
	}, 20000);

	it('--reset removes every seeded row for BOTH channels and leaves other rows untouched', async () => {
		const url = `file:${join(tmp, 'reset.db')}`;
		await applyMigrations(url);
		await runSeed(url);
		const client = createClient({ url });
		await client.execute(
			"INSERT INTO channels (id, title, refresh_token_enc, active) VALUES ('UC-real', 'Real', 'enc', 1)"
		);
		client.close();

		const { code } = await runSeed(url, ['--reset']);
		expect(code).toBe(0);

		const after = createClient({ url });
		for (const id of CHANNEL_IDS) {
			for (const table of ['channels', 'rules', 'comments', 'moderation_actions', 'audit_log']) {
				expect(await countFor(after, table, id), `leftover ${table} rows for ${id}`).toBe(0);
			}
		}
		const sentinel = await after.execute("SELECT count(*) AS n FROM channels WHERE id = 'UC-real'");
		after.close();
		expect(sentinel.rows[0].n).toBe(1);
	}, 20000);

	it('refuses to reseed over existing demo rows (run --reset first)', async () => {
		// Only the SECOND channel exists: the guard must catch it before writing
		// anything, so seed-UC-night-shift must not be inserted either.
		const url = `file:${join(tmp, 'reseed.db')}`;
		await applyMigrations(url);
		const pre = createClient({ url });
		await pre.execute(
			"INSERT INTO channels (id, title, refresh_token_enc, active) VALUES ('seed-UC-morning-show', 'M', 'enc', 0)"
		);
		pre.close();
		const second = await runSeed(url);
		expect(second.code).toBe(1);
		expect(second.stderr).toMatch(/--reset/);
		const client = createClient({ url });
		const night = await client.execute("SELECT count(*) AS n FROM channels WHERE id = 'seed-UC-night-shift'");
		client.close();
		expect(night.rows[0].n).toBe(0);
	}, 20000);

	it('rejects unknown arguments loudly instead of seeding', async () => {
		const url = `file:${join(tmp, 'args.db')}`;
		await applyMigrations(url);
		const { code, stderr } = await runSeed(url, ['--bogus']);
		expect(code).toBe(1);
		expect(stderr).toMatch(/usage/i);
		const client = createClient({ url });
		const n = await client.execute('SELECT count(*) AS n FROM channels');
		client.close();
		expect(n.rows[0].n).toBe(0);
	}, 20000);

	it('rolls back the whole seed when a later channel fails mid-write', async () => {
		// A colliding comment id makes the SECOND channel's inserts fail after
		// the first channel is fully written; the transaction must leave the
		// database as if the seed never ran.
		const url = `file:${join(tmp, 'rollback.db')}`;
		await applyMigrations(url);
		const pre = createClient({ url });
		await pre.execute(
			"INSERT INTO comments (id, channel_id, text, published_at, status, decided_by) VALUES ('seed-morning-comment-05', 'other', 't', '2026-01-01T00:00:00Z', 'pending', 'none')"
		);
		pre.close();
		const { code } = await runSeed(url);
		expect(code).toBe(1);
		const client = createClient({ url });
		for (const id of CHANNEL_IDS) {
			for (const table of ['channels', 'rules', 'moderation_actions', 'audit_log']) {
				expect(await countFor(client, table, id), `rolled-back ${table} rows for ${id}`).toBe(0);
			}
		}
		const seeded = await client.execute("SELECT count(*) AS n FROM comments WHERE channel_id != 'other'");
		client.close();
		expect(seeded.rows[0].n).toBe(0);
	}, 20000);
});
