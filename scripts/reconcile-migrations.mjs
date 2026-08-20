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

let changed = 0;
for (let i = 0; i < journalHashes.length; i++) {
	const row = rows[i];
	const dbHash = String(row.hash);
	const journalHash = journalHashes[i];
	if (dbHash === journalHash) continue;
	console.log(`reconcile-migrations: ${entries[i].tag}: ${dbHash.slice(0, 12)}… -> ${journalHash.slice(0, 12)}…`);
	const writer = createClient({ url, authToken });
	const result = await writer.execute({ sql: 'UPDATE __drizzle_migrations SET hash = ? WHERE rowid = ?', args: [journalHash, Number(row.rowid)] });
	// Prove the write stuck: a read-back must show the new hash. A silent
	// no-op (0 rows affected / old hash still there) means the token cannot
	// write this database — fail loudly instead of reporting success.
	const check = await writer.execute({ sql: 'SELECT hash FROM __drizzle_migrations WHERE rowid = ?', args: [Number(row.rowid)] });
	writer.close();
	const persisted = check.rows.length === 1 && String(check.rows[0].hash) === journalHash;
	if (!persisted) {
		console.error(
			`reconcile-migrations: WRITE DID NOT PERSIST for rowid ${row.rowid} (rows changed: ${JSON.stringify(result.rows ?? [])}). ` +
				'The token appears to be READ-ONLY for this database, or the writes are rejected — nothing was changed.'
		);
		process.exit(1);
	}
	changed++;
}
console.log(`reconcile-migrations: ${changed} hash(es) updated AND verified against ${url}.`);
process.exit(0);
