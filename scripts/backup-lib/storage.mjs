import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupError, atStage, run, safeId, sha256 } from './common.mjs';

const DAY = 86_400_000;
export const RETENTION_DAYS = 30;
export const BACKUP_ID = /^\d{8}T\d{9}Z-[0-9a-f-]{36}$/;
export function storageConfig(env = process.env) {
	const bucket = env.BACKUP_S3_BUCKET;
	const owner = env.BACKUP_S3_ACCOUNT_ID;
	const region = env.BACKUP_S3_REGION;
	if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '') || !/^\d{12}$/.test(owner ?? '') || !/^[a-z]{2}-[a-z]+-\d$/.test(region ?? '')) {
		throw new BackupError('configuration', 'Approved S3 bucket, account ID and region are required.');
	}
	return { bucket, owner, region, prefix: `moderaty-backups/${safeId(env.BACKUP_SCOPE, 'backup scope')}/` };
}

// Dedicated AWS S3 adapter. No arbitrary endpoint override or public artifact
// transport. Other providers need a reviewed adapter and owner approval.
export function s3Store(config, { env = process.env, signal, runTool = run } = {}) {
	const commandEnv = { ...env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_MAX_ATTEMPTS: '3', AWS_RETRY_MODE: 'standard', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' };
	for (const key of Object.keys(commandEnv)) if (key.startsWith('AWS_ENDPOINT_URL')) delete commandEnv[key];
	async function command(operation, args = [], stage = 'storage') {
		return atStage(stage, async () => {
			const result = await runTool('aws', ['s3api', operation, '--bucket', config.bucket, '--expected-bucket-owner', config.owner, '--region', config.region, '--no-cli-pager', '--output', 'json', ...args], { env: commandEnv, signal, timeout: 120_000 });
			return result.length ? JSON.parse(result) : {};
		});
	}
	async function temporary(action) {
		const dir = mkdtempSync(join(tmpdir(), 'moderaty-backup-cipher-'));
		try { return await action(dir); }
		finally { await atStage('cleanup', async () => rmSync(dir, { recursive: true, force: true })); }
	}
	return {
		async preflight() {
			const version = (await runTool('aws', ['--version'], { env: commandEnv, signal, maxBytes: 4096 })).toString();
			if (!version.startsWith('aws-cli/2.37.8 ')) throw new BackupError('configuration', 'AWS CLI 2.37.8 is required.');
			const block = (await command('get-public-access-block')).PublicAccessBlockConfiguration;
			if (!block || ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'].some((key) => block[key] !== true)) throw new BackupError('storage', 'S3 public access must be fully blocked.');
			const versioning = await command('get-bucket-versioning');
			if (versioning.Status !== undefined) throw new BackupError('storage', 'S3 versioning must never have been enabled; version-aware retention needs a separate design.');
			// Object Lock requires versioning; the preceding check also excludes locked buckets.
			const ownership = (await command('get-bucket-ownership-controls')).OwnershipControls;
			if (!ownership?.Rules?.some((r) => r.ObjectOwnership === 'BucketOwnerEnforced')) throw new BackupError('storage', 'S3 bucket-owner-enforced ownership is required.');
		},
		async put(key, bytes, contentType) {
			if (!key.startsWith(config.prefix) || !/\/(payload\.sql\.gz\.age|complete\.json)$/.test(key)) throw new BackupError('storage', 'Refusing an unsupported upload payload.');
			if (key.endsWith('/payload.sql.gz.age') && !bytes.subarray(0, 22).toString().startsWith('age-encryption.org/v1\n')) throw new BackupError('storage', 'Refusing a non-age payload.');
			if (key.endsWith('/complete.json')) {
				let parsed; try { parsed = JSON.parse(bytes); } catch { throw new BackupError('integrity', 'Invalid completion manifest.'); }
				validateManifest(parsed, { scope: config.prefix.split('/')[1], id: key.slice(config.prefix.length, -'/complete.json'.length) });
			}
			await temporary(async (dir) => {
				const file = join(dir, 'encrypted-or-manifest'); writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
				await command('put-object', ['--key', key, '--body', file, '--if-none-match', '*', '--checksum-algorithm', 'SHA256', '--checksum-sha256', Buffer.from(sha256(bytes), 'hex').toString('base64'), '--content-type', contentType]);
			});
		},
		async get(key, maxBytes = 65 * 1024 * 1024) {
			return temporary(async (dir) => {
				const file = join(dir, 'ciphertext');
				await command('get-object', ['--key', key, '--range', `bytes=0-${maxBytes}`, file]);
				const bytes = readFileSync(file);
				if (bytes.length > maxBytes) throw new BackupError('integrity', 'Stored object exceeds its permitted size.');
				return bytes;
			});
		},
		async list() {
			// AWS CLI auto-paginates; malformed/truncated lists fail closed.
			const response = await command('list-objects-v2', ['--prefix', config.prefix]);
			if (response.IsTruncated || (response.Contents !== undefined && !Array.isArray(response.Contents))) throw new BackupError('storage', 'Incomplete storage inventory.');
			return response.Contents ?? [];
		},
		async remove(key) { await command('delete-object', ['--key', key], 'retention'); }
	};
}

export function validateManifest(value, { scope, id } = {}) {
	const keys = ['format', 'id', 'scope', 'startedAt', 'completedAt', 'schemaVersion', 'schemaHash', 'exportTool', 'encryption', 'keyId', 'bytes', 'sha256'];
	if (!value || !Object.keys(value).every((k) => keys.includes(k)) || keys.some((k) => !(k in value)) || value.format !== 1 || !BACKUP_ID.test(value.id) || (id && value.id !== id) || value.scope !== scope || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.startedAt) || !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.completedAt)) || Date.parse(value.completedAt) < Date.parse(value.startedAt) || !/^[0-9a-f]{64}$/.test(value.sha256) || !/^[0-9a-f]{64}$/.test(value.schemaHash) || !/^[0-9a-f]{24}$/.test(value.keyId) || value.encryption !== 'age-x25519-v1+gzip' || !Number.isSafeInteger(value.bytes) || value.bytes < 100 || value.bytes > 65 * 1024 * 1024 || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.schemaVersion) || !['turso-cli-1.0.31-dump', 'turso-http-dump-v1'].includes(value.exportTool)) throw new BackupError('integrity', 'Invalid backup completion manifest.');
	return value;
}
export async function verifyObject(store, key, expected) {
	const bytes = await store.get(key, expected.bytes);
	if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new BackupError('integrity', 'Stored backup checksum or size mismatch.');
	return bytes;
}
export async function completedBackups(store, config) {
	const objects = await store.list(); const manifests = [];
	for (const object of objects) {
		if (!object.Key?.startsWith(config.prefix) || !object.Key.endsWith('/complete.json')) continue;
		const id = object.Key.slice(config.prefix.length, -'/complete.json'.length);
		if (!BACKUP_ID.test(id)) throw new BackupError('integrity', 'Unexpected completion-marker path.');
		const bytes = await store.get(object.Key, 8192);
		if (bytes.length > 8192) throw new BackupError('integrity', 'Completion manifest exceeds its limit.');
		let parsed; try { parsed = JSON.parse(bytes); } catch { throw new BackupError('integrity', 'Unreadable completion manifest.'); }
		manifests.push(validateManifest(parsed, { scope: config.prefix.split('/')[1], id }));
	}
	return { objects, manifests: manifests.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)) };
}
export async function enforceRetention(store, config, current, now = new Date()) {
	const { objects, manifests } = await completedBackups(store, config);
	const newest = manifests[0];
	if (!newest || newest.id !== current.id || now - Date.parse(newest.startedAt) > DAY) throw new BackupError('retention', 'Retention requires the new verified backup; preserve recovery copies and escalate.');
	await verifyObject(store, `${config.prefix}${newest.id}/payload.sql.gz.age`, newest);
	const cutoff = now.getTime() - RETENTION_DAYS * DAY;
	for (const backup of manifests) {
		if (backup.id === newest.id || Date.parse(backup.startedAt) >= cutoff) continue;
		// Remove marker first: a partial deletion cannot remain a success signal.
		await store.remove(`${config.prefix}${backup.id}/complete.json`);
		await store.remove(`${config.prefix}${backup.id}/payload.sql.gz.age`);
	}
	for (const object of objects) {
		if (!object.Key?.startsWith(config.prefix) || !object.Key.endsWith('/payload.sql.gz.age')) continue;
		const id = object.Key.slice(config.prefix.length, -'/payload.sql.gz.age'.length);
		if (BACKUP_ID.test(id) && !manifests.some((m) => m.id === id) && Number.isFinite(Date.parse(object.LastModified)) && Date.parse(object.LastModified) < cutoff) await store.remove(object.Key);
	}
}
