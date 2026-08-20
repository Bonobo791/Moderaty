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
// Migration bookkeeping reconciliation (2026-08-20 incident): commit b28a45f
// swapped the license header inside the 16 older drizzle migration SQL files,
// which changed their sha256. The DDL was ALREADY applied to the database, but
// __drizzle_migrations still records the pre-swap hashes, so verify-migrations
// reports "16 missing, 16 extra" and the deploy gate fails.
//
// Writes key on rowid, NOT `id`: drizzle's migrator creates `id SERIAL PRIMARY
// KEY`, which SQLite does NOT auto-increment (only INTEGER PRIMARY KEY aliases
// the rowid) and allows NULLs in — so every row's id is NULL on real databases
// and `WHERE id = ?` silently matches nothing (the 2026-08-20 incident).
//
// This script rewrites ONLY the __drizzle_migrations bookkeeping rows so their
// hashes match the current journal — it never runs DDL and never touches the
// schema. It is intentionally strict: it refuses to run unless the journal and
// the database agree on the NUMBER of applied migrations (positional alignment
// is only safe for a same-count drift, which is exactly what a content-only
// edit produces).
//
// Usage (run with the target environment's .env sourced):
//   node scripts/reconcile-migrations.mjs [meta-dir]
// Exit 0 = reconciled (or nothing to do); 1 = cannot safely reconcile.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { loadMigrationConfig, readJournal } from './migration-config.mjs';

const { metaDir, url, authToken, journalPath } = loadMigrationConfig({ scriptName: 'reconcile-migrations' });
const journal = readJournal(journalPath, 'reconcile-migrations');
const entries = journal.entries ?? [];

// Attestation gate (CodeRabbit #131): equal row counts are NOT identity.
// The operator must supply the current DB hashes (rowid order) as
// RECONCILE_EXPECTED_HASHES — a JSON array of 64-hex strings — to attest that
// every mismatched row is the SAME migration whose recorded hash merely
// drifted (e.g. the 2026-08-20 license-header swap). Without the attestation,
// or when a row fails to match its attested predecessor, the script refuses
// and changes nothing.
let expectedHashes = null;
const expectedHashesRaw = process.env.RECONCILE_EXPECTED_HASHES;
if (expectedHashesRaw !== undefined) {
	try {
		expectedHashes = JSON.parse(expectedHashesRaw);
	} catch {
		console.error('reconcile-migrations: RECONCILE_EXPECTED_HASHES must be a JSON array of 64-char hex hashes (the current DB row hashes, in rowid order)');
		process.exit(1);
	}
	if (
		!Array.isArray(expectedHashes) ||
		expectedHashes.some((h) => typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h))
	) {
		console.error('reconcile-migrations: RECONCILE_EXPECTED_HASHES must be a JSON array of 64-char hex hashes (the current DB row hashes, in rowid order)');
		process.exit(1);
	}
}
const journalHashes = entries.map((e) => {
	const file = join(metaDir, '..', `${e.tag}.sql`);
	if (!existsSync(file)) throw new Error(`reconcile-migrations: migration file missing: ${file}`);
	return createHash('sha256').update(readFileSync(file)).digest('hex');
});

// Print the target BEFORE any write so a run against the wrong database is
// obvious (the 2026-08-20 incident: an earlier run reconciled a dev DB while
// production kept its drifted hashes).
console.log(`reconcile-migrations: target ${url}`);
const client = createClient({ url, authToken });
const rows = (await client.execute('SELECT rowid, hash FROM __drizzle_migrations ORDER BY rowid')).rows;
client.close();
console.log(`reconcile-migrations: ${rows.length} applied rows, ${journalHashes.length} journal entries`);

if (rows.length !== journalHashes.length) {
	console.error(
		`reconcile-migrations: REFUSING — database has ${rows.length} applied migrations but the journal has ${journalHashes.length}. ` +
			'Only a same-count hash drift can be reconciled positionally; a genuine add/missing migration needs a human (DEPLOY.md §1).'
	);
	process.exit(1);
}
if (expectedHashes !== null && expectedHashes.length !== rows.length) {
	console.error(
		`reconcile-migrations: REFUSING — RECONCILE_EXPECTED_HASHES has ${expectedHashes.length} entries but the database has ${rows.length} applied migrations.`
	);
	process.exit(1);
}

// Plan the changes WITHOUT writing: every mismatched row must match its
// attested predecessor at the same position, or the run refuses untouched.
const changes = [];
for (let i = 0; i < journalHashes.length; i++) {
	const row = rows[i];
	const dbHash = String(row.hash);
	const journalHash = journalHashes[i];
	if (dbHash === journalHash) continue;
	if (expectedHashes === null) {
		console.error(
			`reconcile-migrations: REFUSING — rowid ${row.rowid} (${entries[i].tag}) hash ${dbHash.slice(0, 12)}… differs from the journal but no ` +
				'RECONCILE_EXPECTED_HASHES were supplied. Dump the current DB hashes in rowid order and pass them to attest these are the same ' +
				'migrations, hash-drifted only — nothing was changed.'
		);
		process.exit(1);
	}
	if (expectedHashes[i] !== dbHash) {
		console.error(
			`reconcile-migrations: REFUSING — rowid ${row.rowid} (${entries[i].tag}) hash ${dbHash.slice(0, 12)}… does not match the approved ` +
				`predecessor ${(expectedHashes[i] ?? '<missing>').slice(0, 12)}… at position ${i}. The migration sequence differs from the attestation — ` +
				'nothing was changed.'
		);
		process.exit(1);
	}
	changes.push({ rowid: Number(row.rowid), tag: entries[i].tag, dbHash, journalHash });
}

if (changes.length === 0) {
	console.log('reconcile-migrations: no drift — all recorded hashes already match the journal.');
	process.exit(0);
}
for (const change of changes) {
	console.log(`reconcile-migrations: ${change.tag}: ${change.dbHash.slice(0, 12)}… -> ${change.journalHash.slice(0, 12)}…`);
}

// Apply ALL updates and read-back checks in ONE explicit write transaction,
// committing only after every persisted validation succeeds (CodeRabbit #131):
// any statement error or failed read-back rolls the whole run back, so a
// mid-run failure can never leave a partial reconciliation — and the exit-1
// "nothing was changed" claim is only ever made after a real rollback, never
// after an implicit batch commit.
const writer = createClient({ url, authToken });
let tx;
try {
	tx = await writer.transaction('write');
} catch (error) {
	writer.close();
	console.error(`reconcile-migrations: could not open a write transaction (${error.message}) — nothing was changed.`);
	process.exit(1);
}
try {
	for (const change of changes) {
		const result = await tx.execute({
			sql: 'UPDATE __drizzle_migrations SET hash = ? WHERE rowid = ?',
			args: [change.journalHash, change.rowid]
		});
		if (Number(result.rowsAffected) !== 1) {
			throw new Error(`UPDATE for rowid ${change.rowid} (${change.tag}) affected ${result.rowsAffected} rows`);
		}
		// Read back inside the transaction: the staged update must already
		// show the new hash before we will commit it.
		const check = await tx.execute({
			sql: 'SELECT hash FROM __drizzle_migrations WHERE rowid = ?',
			args: [change.rowid]
		});
		if (check.rows.length !== 1 || String(check.rows[0].hash) !== change.journalHash) {
			throw new Error(`read-back for rowid ${change.rowid} (${change.tag}) did not show the new hash`);
		}
	}
	await tx.commit();
} catch (error) {
	await tx.rollback().catch(() => {});
	writer.close();
	console.error(
		`reconcile-migrations: update failed and was rolled back (${error.message}) — nothing was changed. ` +
			'The token may be READ-ONLY for this database, or the writes are rejected.'
	);
	process.exit(1);
}
writer.close();
console.log(`reconcile-migrations: ${changes.length} hash(es) updated AND verified against ${url}.`);
process.exit(0);
