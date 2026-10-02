#!/usr/bin/env node
// Synthetic rehearsal only. Ephemeral test identities are never production keys.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { run, sha256 } from './backup-lib/common.mjs';
import { encryptDump, decryptDump } from './backup-lib/encryption.mjs';
import { syntheticDump, simpleContract, fullContract } from './backup-lib/fixtures.mjs';
import { validateDump } from './backup-lib/schema.mjs';
const dir = mkdtempSync(join(tmpdir(), 'moderaty-synthetic-rehearsal-'));
const started = performance.now();
try {
	const key = join(dir, 'test-identity');
	await run('age-keygen', ['--output', key]);
	const recipient = (await run('age-keygen', ['--y', key])).toString().trim();
	const dump = syntheticDump();
	const encrypted = await encryptDump(dump, recipient);
	const file = join(dir, 'payload.sql.gz.age'); writeFileSync(file, encrypted, { mode: 0o600 });
	assert.equal(sha256(readFileSync(file)), sha256(encrypted));
	// Simulate routine CI loss: recovery uses only the separately held identity
	// file and downloaded ciphertext, not any export/storage credentials.
	const restored = await decryptDump(readFileSync(file), key);
	validateDump(restored, simpleContract, (db) => assert.equal(db.prepare('SELECT count(*) AS n FROM child JOIN parent ON child.parent_id=parent.id').get().n, 1));
	restored.fill(0); dump.fill(0);
	const corrupt = Buffer.from(encrypted); corrupt[corrupt.length - 1] ^= 1;
	await assert.rejects(decryptDump(corrupt, key));
	const other = join(dir, 'wrong-test-identity'); await run('age-keygen', ['--output', other]);
	await assert.rejects(decryptDump(encrypted, other));
	await assert.rejects(decryptDump(encrypted, join(dir, 'missing-identity')));
	// Independently held emergency copy works when the primary test identity is lost.
	const emergency = join(dir, 'emergency-test-identity'); writeFileSync(emergency, readFileSync(key), { mode: 0o600 }); rmSync(key);
	const recovered = await decryptDump(encrypted, emergency); validateDump(recovered, simpleContract); recovered.fill(0);
	const contract = fullContract(); const fullDump = syntheticDump(contract, false);
	const fullEncrypted = await encryptDump(fullDump, recipient);
	const fullRestore = await decryptDump(fullEncrypted, emergency);
	validateDump(fullRestore, contract); fullRestore.fill(0); fullDump.fill(0);
	assert.ok(readdirSync(dir).every((name) => !name.endsWith('.sql') && !name.endsWith('.db')));
	console.log(`backup-rehearsal: PASS; encrypted recovery, full schema, corruption/wrong-key/lost-key failures and emergency custody; ${Math.ceil(performance.now() - started)} ms.`);
} finally { rmSync(dir, { recursive: true, force: true }); }
