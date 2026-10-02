#!/usr/bin/env node
// Offline, memory-only restore verification; never starts the application,
// contacts a database or writes a plaintext restore file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BackupError, cancellation, reportError, sha256 } from './backup-lib/common.mjs';
import { decryptDump } from './backup-lib/encryption.mjs';
import { loadContract, validateDump } from './backup-lib/schema.mjs';
import { validateManifest } from './backup-lib/storage.mjs';
const stop = cancellation();
try {
	const [dir, identity] = process.argv.slice(2);
	if (process.argv.length !== 4) throw new BackupError('usage', 'Usage: node scripts/verify-backup.mjs <encrypted-backup-directory> <private-age-identity-path>');
	const manifest = validateManifest(JSON.parse(readFileSync(join(dir, 'complete.json'))), { scope: process.env.BACKUP_SCOPE });
	const ciphertext = readFileSync(join(dir, 'payload.sql.gz.age'));
	if (ciphertext.length !== manifest.bytes || sha256(ciphertext) !== manifest.sha256) throw new BackupError('integrity', 'Ciphertext checksum or length mismatch.');
	const contract = loadContract();
	if (manifest.schemaHash !== contract.schemaHash || manifest.schemaVersion !== contract.version) throw new BackupError('validation', 'Use the reviewed source revision matching this backup schema.');
	const dump = await decryptDump(ciphertext, identity, { signal: stop.signal });
	try { validateDump(dump, contract); } finally { dump.fill(0); }
	console.log(`backup-restore: offline integrity, schema and migration verification passed (${manifest.id}).`);
} catch (error) { reportError(error); }
finally { stop.dispose(); }
