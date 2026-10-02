#!/usr/bin/env node
// Encrypted-only backup. No SQL, source responses, secrets or decrypted files
// are written to disk/logs. Production credentials remain an operator gate.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BackupError, cancellation, reportError, safeId, sha256 } from './backup-lib/common.mjs';
import { exportDump } from './backup-lib/export.mjs';
import { loadContract, validateDump } from './backup-lib/schema.mjs';
import { recipientConfig, encryptDump } from './backup-lib/encryption.mjs';
import { s3Store, storageConfig, verifyObject, enforceRetention } from './backup-lib/storage.mjs';

export async function backup(database, outDir, { env = process.env, signal, contract = loadContract(), exportData = exportDump, encrypt = encryptDump, store } = {}) {
	safeId(database, 'Turso database name');
	const scope = safeId(env.BACKUP_SCOPE, 'backup scope');
	const { recipient, keyId } = recipientConfig(env);
	const remote = outDir === '--upload';
	if (remote && env.BACKUP_PRODUCTION_ENABLED !== 'true') throw new BackupError('configuration', 'Remote backup activation has not been approved/enabled.');
	const config = remote ? storageConfig(env) : null;
	const destination = remote ? store ?? s3Store(config, { env, signal }) : null;
	if (destination) await destination.preflight();
	const startedAt = new Date().toISOString();
	const id = `${startedAt.replace(/[-:.]/g, '')}-${randomUUID()}`;
	const { dump, tool } = await exportData(database, { env, signal });
	const schema = validateDump(dump, contract);
	let encrypted;
	try { encrypted = await encrypt(dump, recipient, { signal }); }
	finally { dump.fill(0); }
	signal?.throwIfAborted();
	const manifest = { format: 1, id, scope, startedAt, completedAt: new Date().toISOString(), schemaVersion: schema.version, schemaHash: schema.schemaHash, exportTool: tool, encryption: 'age-x25519-v1+gzip', keyId, bytes: encrypted.length, sha256: sha256(encrypted) };
	const metadata = Buffer.from(`${JSON.stringify(manifest)}\n`);
	if (destination) {
		const prefix = `${config.prefix}${id}/`;
		await destination.put(`${prefix}payload.sql.gz.age`, encrypted, 'application/octet-stream');
		await verifyObject(destination, `${prefix}payload.sql.gz.age`, manifest);
		signal?.throwIfAborted();
		await destination.put(`${prefix}complete.json`, metadata, 'application/json');
		if (!(await destination.get(`${prefix}complete.json`)).equals(metadata)) throw new BackupError('integrity', 'Stored completion marker mismatch.');
		await enforceRetention(destination, config, manifest);
	} else {
		mkdirSync(outDir, { recursive: true, mode: 0o700 });
		const dir = join(outDir, id); mkdirSync(dir, { mode: 0o700 });
		try {
			writeFileSync(join(dir, 'payload.sql.gz.age'), encrypted, { mode: 0o600, flag: 'wx' });
			writeFileSync(join(dir, 'complete.json'), metadata, { mode: 0o600, flag: 'wx' });
		} catch { rmSync(dir, { recursive: true, force: true }); throw new BackupError('output', 'Could not write encrypted backup; incomplete output removed.'); }
	}
	return manifest;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const stop = cancellation(); process.umask(0o077);
	try {
		const args = process.argv.slice(2);
		if (args.length !== 2) throw new BackupError('usage', 'Usage: node scripts/backup-db.mjs <turso-db-name> <output-dir|--upload>');
		const result = await backup(...args, { signal: stop.signal });
		console.log(`backup: encrypted backup verified (${result.id}).`);
	} catch (error) { reportError(error); }
	finally { stop.dispose(); }
}
