#!/usr/bin/env node
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
//
// Schema verification: proves that every migration in drizzle/meta/_journal.json
// is actually applied to the database TURSO_DATABASE_URL points at. READ ONLY —
// it never creates tables, writes rows, or modifies the schema, so it is safe
// to run against production. It mirrors drizzle-kit's own matching exactly:
// an applied migration is recorded in __drizzle_migrations as the sha256 hex
// of the migration file's contents, so this script recomputes that hash per
// journal entry and compares. That catches the documented failure mode where
// `drizzle-kit migrate` exits 0 without applying anything (the 0007/0008
// incidents) — verification never trusts an exit code.
//
// Exit code 0 = every journal entry is applied and nothing extra is recorded;
// 1 = at least one migration is missing or the journal/database drifted (each
// problem prints loudly with names).
//
// Usage:
//   node scripts/verify-migrations.mjs [meta-dir]
// Default meta-dir is <repo>/drizzle/meta; pass another only for tests.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

// Validate the full argument list BEFORE any work: unknown or extra arguments
// are a loud usage error, never a silent fallthrough.
const argv = process.argv.slice(2);
if (argv.length > 1) {
	console.error('Usage: node scripts/verify-migrations.mjs [meta-dir]');
	process.exit(1);
}
const metaDir = argv[0] ?? fileURLToPath(new URL('../drizzle/meta', import.meta.url));

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
	console.error('verify-migrations: TURSO_DATABASE_URL is not set (use --env-file=.env)');
	process.exit(1);
}
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url.startsWith('file:') && !authToken) {
	console.error('verify-migrations: TURSO_AUTH_TOKEN is required for remote databases');
	process.exit(1);
}

const journalPath = join(metaDir, '_journal.json');
if (!existsSync(journalPath)) {
	console.error(`verify-migrations: no journal at ${journalPath} — cannot verify what should be applied`);
	process.exit(1);
}

let journalEntries;
try {
	journalEntries = JSON.parse(readFileSync(journalPath, 'utf8')).entries ?? [];
} catch (error) {
	console.error(`verify-migrations: cannot read journal ${journalPath}: ${error.message}`);
	process.exit(1);
}

/** sha256 hex of a migration file's contents — exactly what drizzle-kit stores. */
function migrationHash(sql) {
	return createHash('sha256').update(sql).digest('hex');
}

/**
 * Pure comparison: which journal entries are unapplied, and which applied
 * hashes have no journal entry (drift). `journalEntries` items are
 * `{ tag, hash }`; `appliedHashes` is the set of hashes recorded in
 * `__drizzle_migrations`. Returns `{ missing: string[], extra: string[] }`.
 */
export function findMissingMigrations(journalEntries, appliedHashes) {
	const applied = new Set(appliedHashes);
	const expected = new Set(journalEntries.map((entry) => entry.hash));
	const missing = [];
	for (const entry of journalEntries) {
		if (!applied.has(entry.hash)) missing.push(entry.tag);
	}
	// Set.has() lookups only — no string comparison operators on hash values,
	// so the comparison cannot leak anything even in theory (the hashes are
	// non-secret integrity values anyway, but the shape stays clean).
	const extra = [];
	for (const hash of applied) {
		if (!expected.has(hash)) extra.push(hash);
	}
	return { missing, extra };
}

const client = createClient({ url, authToken });

// Build the journal entries with their expected hashes. A journal tag without
// its SQL file is a broken repo and must fail loudly, like drizzle-kit itself.
const expected = [];
for (const entry of journalEntries) {
	const sqlPath = join(metaDir, '..', `${entry.tag}.sql`);
	if (!existsSync(sqlPath)) {
		console.error(`verify-migrations: journal references ${sqlPath}, which does not exist — refusing to verify a broken journal`);
		process.exit(1);
	}
	expected.push({ tag: entry.tag, hash: migrationHash(readFileSync(sqlPath, 'utf8')) });
}

let appliedHashes = [];
try {
	// A fresh database has no __drizzle_migrations table yet; that means zero
	// migrations are applied, which is a loud FAIL listing every journal entry
	// (migrate first), never a silent pass. Any other query failure means the
	// verification cannot read the database at all — abort loudly rather than
	// report a misleading MISSING list.
	const result = await client.execute('SELECT hash FROM __drizzle_migrations');
	appliedHashes = result.rows.map((row) => String(row.hash));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (/no such table/.test(message)) {
		console.error('verify-migrations: __drizzle_migrations does not exist — no migrations are applied to this database yet');
	} else {
		console.error(`verify-migrations: cannot read __drizzle_migrations: ${message}`);
		client.close();
		process.exit(1);
	}
} finally {
	client.close();
}

console.log(`verify-migrations against ${url}`);
const { missing, extra } = findMissingMigrations(expected, appliedHashes);
for (const tag of missing) {
	console.error(`verify-migrations: MISSING ${tag} — the database schema is behind the migrations in this build`);
}
for (const hash of extra) {
	console.error(`verify-migrations: EXTRA applied hash ${hash.slice(0, 12)}… has no journal entry — the database drifted from this repo`);
}

if (missing.length === 0 && extra.length === 0) {
	const first = expected[0]?.tag ?? '(none)';
	const last = expected.at(-1)?.tag ?? '(none)';
	console.log(
		expected.length === 0
			? 'verify-migrations: PASS — journal has no entries to verify'
			: `verify-migrations: PASS — all ${expected.length} migrations applied (${first} … ${last})`
	);
	process.exit(0);
}

console.error(
	`verify-migrations: FAIL — ${missing.length} missing, ${extra.length} extra (${expected.length} journal entries, ${appliedHashes.length} applied)`
);
process.exit(1);
