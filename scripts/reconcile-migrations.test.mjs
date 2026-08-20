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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createClient } from '@libsql/client';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Reuse the real journal + migration files from the repo.
const metaDir = join(ROOT, 'drizzle', 'meta');
const journal = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf8'));
const entries = journal.entries ?? [];
const realHashes = entries.map((e) =>
	createHash('sha256').update(readFileSync(join(metaDir, '..', `${e.tag}.sql`))).digest('hex')
);

const tempDirs = [];
function tempDb() {
	const dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
	tempDirs.push(dir);
	return join(dir, 'drifted.db');
}
async function seededDb(dbPath, hashes) {
	const client = createClient({ url: `file:${dbPath}` });
	await client.execute("CREATE TABLE __drizzle_migrations (\n\t\t\tid SERIAL PRIMARY KEY,\n\t\t\thash text NOT NULL,\n\t\t\tcreated_at numeric\n\t\t)");
	for (let i = 0; i < hashes.length; i++) {
		await client.execute({ sql: 'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)', args: [hashes[i], String(1785326400000 + i)] });
	}
	client.close();
}
function reconcile(dbPath, { expectedHashes } = {}) {
	return execFileSync(process.execPath, [join(ROOT, 'scripts', 'reconcile-migrations.mjs'), metaDir], {
		encoding: 'utf8',
		env: {
			...process.env,
			TURSO_DATABASE_URL: `file:${dbPath}`,
			TURSO_AUTH_TOKEN: '',
			...(expectedHashes ? { RECONCILE_EXPECTED_HASHES: JSON.stringify(expectedHashes) } : {})
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
}
function expectRefusal(dbPath, { expectedHashes, pattern = /REFUSING/ } = {}) {
	let error;
	try {
		reconcile(dbPath, { expectedHashes });
	} catch (e) {
		error = e;
	}
	// Real framework assertions so every refusal test is counted (SonarCloud
	// S2699): the script must exit non-zero AND print the expected refusal.
	expect(error).toBeDefined();
	expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toMatch(pattern);
}
async function appliedHashes(dbPath) {
	const client = createClient({ url: `file:${dbPath}` });
	const { rows } = await client.execute('SELECT hash FROM __drizzle_migrations ORDER BY rowid');
	client.close();
	return rows.map((r) => String(r.hash));
}

beforeEach(() => {});
afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('reconcile-migrations', () => {
	test('rewrites drifted hashes to the journal when the operator attests the predecessors, and leaves matched ones alone', async () => {
		const db = tempDb();
		// Simulate the license-header drift: first 16 rows have wrong hashes.
		const drifted = realHashes.map((h, i) => (i < 16 ? createHash('sha256').update(`old-content-${i}`).digest('hex') : h));
		await seededDb(db, drifted);

		// The attestation is exactly what the operator dumps from the DB: the
		// current row hashes in rowid order.
		const out = reconcile(db, { expectedHashes: drifted });

		expect(out).toMatch(/16 hash\(es\) updated/);
		expect(await appliedHashes(db)).toEqual(realHashes);
	});

	test('refuses to run when the applied count differs from the journal', async () => {
		const db = tempDb();
		await seededDb(db, realHashes.slice(0, 20));
		const before = await appliedHashes(db);
		expectRefusal(db, { pattern: /database has 20 applied migrations but the journal has/ });
		expect(await appliedHashes(db)).toEqual(before); // refusal preserves the evidence
	});

	test('refuses same-count drift with no attestation: unrelated hashes must not be overwritten', async () => {
		const db = tempDb();
		// Same count as the journal, but hashes that match nothing (a different
		// migration sequence applied). Equal counts are NOT identity.
		const unrelated = realHashes.map((h, i) => createHash('sha256').update(`unrelated-${i}`).digest('hex'));
		await seededDb(db, unrelated);

		expectRefusal(db, { pattern: /RECONCILE_EXPECTED_HASHES/ });
		expect(await appliedHashes(db)).toEqual(unrelated); // evidence untouched
	});

	test('refuses when a row does not match its attested predecessor — nothing is changed', async () => {
		const db = tempDb();
		// One genuine drift (row 0) plus one unrelated hash (row 1): the
		// attestation for row 1 is wrong, so the whole run must refuse and
		// must not have applied the (valid) row-0 update either.
		const drifted = realHashes.map((h, i) => (i === 0 ? createHash('sha256').update('old-content-0').digest('hex') : i === 1 ? createHash('sha256').update('unrelated-1').digest('hex') : h));
		await seededDb(db, drifted);
		const attestation = realHashes.map((h, i) => (i === 1 ? createHash('sha256').update('wrong-attestation-1').digest('hex') : drifted[i]));

		expectRefusal(db, { expectedHashes: attestation, pattern: /does not match the approved predecessor/ });
		expect(await appliedHashes(db)).toEqual(drifted); // NO partial writes
	});
});
