import { describe, expect, it, vi } from 'vitest';
import { sha256 } from './backup-lib/common.mjs';
import { backup } from './backup-db.mjs';
import { simpleContract, syntheticDump } from './backup-lib/fixtures.mjs';
import { checkFreshness, monitorOnce } from './backup-lib/freshness.mjs';
import { notify } from './backup-lib/alerts.mjs';
import { enforceRetention, s3Store } from './backup-lib/storage.mjs';

const config = { prefix: 'moderaty-backups/synthetic/', bucket: 'synthetic-bucket', owner: '000000000000', region: 'us-east-1' };
const env = { BACKUP_SCOPE: 'synthetic', BACKUP_S3_BUCKET: config.bucket, BACKUP_S3_ACCOUNT_ID: config.owner, BACKUP_S3_REGION: config.region, BACKUP_PRODUCTION_ENABLED: 'true', BACKUP_AGE_RECIPIENT: `age1${'a'.repeat(58)}` };
const ciphertext = Buffer.from(`age-encryption.org/v1\n${'encrypted'.repeat(30)}`);
const now = new Date('2026-10-02T04:00:00.000Z');
function manifest(date, suffix = '1') {
	return { format: 1, id: `${date.replace(/[-:.]/g, '')}-00000000-0000-4000-8000-${suffix.repeat(12)}`, scope: 'synthetic', startedAt: date, completedAt: date, schemaVersion: '0000_fixture', schemaHash: simpleContract.schemaHash, exportTool: 'turso-http-dump-v1', encryption: 'age-x25519-v1+gzip', keyId: 'a'.repeat(24), bytes: ciphertext.length, sha256: sha256(ciphertext) };
}
function fakeStore(backups = []) {
	const map = new Map();
	for (const backup of backups) { map.set(`${config.prefix}${backup.id}/payload.sql.gz.age`, ciphertext); map.set(`${config.prefix}${backup.id}/complete.json`, Buffer.from(JSON.stringify(backup))); }
	return { map, head: vi.fn(async (key) => { if (!map.has(key)) throw Error('not found'); const bytes = map.get(key); return { bytes: bytes.length, sha256: sha256(bytes) }; }), preflight: vi.fn(async () => {}), put: vi.fn(async (key, bytes) => { if (map.has(key)) throw Error('immutable'); map.set(key, bytes); }), get: vi.fn(async (key) => { if (!map.has(key)) throw Error('not found'); return map.get(key); }), list: vi.fn(async () => [...map.keys()].map((Key) => ({ Key, LastModified: now.toISOString() }))), remove: vi.fn(async (key) => { map.delete(key); }) };
}
const options = (store) => ({ env, contract: simpleContract, store, exportData: async () => ({ dump: syntheticDump(), tool: 'turso-http-dump-v1' }), encrypt: async () => ciphertext });

describe('durable completion and retention', () => {
	it('uploads ciphertext, verifies readback, then writes completion marker and verifies it', async () => {
		const store = fakeStore(); const result = await backup('fixture', '--upload', options(store));
		expect(store.put.mock.calls.map(([key]) => key.split('/').at(-1))).toEqual(['payload.sql.gz.age', 'complete.json']);
		expect(store.get.mock.calls[0][0]).toContain('payload.sql.gz.age');
		expect(store.map.get(`${config.prefix}${result.id}/payload.sql.gz.age`)).toEqual(ciphertext);
	});
	it.each(['upload', 'checksum', 'marker'])('does not falsely succeed on %s failure', async (failure) => {
		const store = fakeStore();
		if (failure === 'upload') store.put.mockRejectedValue(Error('storage denied secret'));
		if (failure === 'checksum') store.get.mockResolvedValue(Buffer.from('corrupted'));
		if (failure === 'marker') store.put.mockImplementation(async (key, data) => { if (key.endsWith('complete.json')) throw Error('partial'); store.map.set(key, data); });
		await expect(backup('fixture', '--upload', options(store))).rejects.toThrow();
		expect([...store.map.keys()].filter((key) => key.endsWith('complete.json'))).toEqual([]);
	});
	it('keeps the exact 30-day UTC boundary and newest good backup; removes only older complete pairs', async () => {
		const recent = manifest(now.toISOString());
		const boundary = manifest(new Date(now - 30 * 86400000).toISOString(), '2');
		const old = manifest(new Date(now - 30 * 86400000 - 1).toISOString(), '3');
		const store = fakeStore([recent, boundary, old]);
		await enforceRetention(store, config, recent, now);
		expect(store.remove.mock.calls.map(([key]) => key)).toEqual([`${config.prefix}${old.id}/complete.json`, `${config.prefix}${old.id}/payload.sql.gz.age`]);
		expect(store.map.has(`${config.prefix}${boundary.id}/complete.json`)).toBe(true);
	});
	it('never deletes anything without a new verified recovery copy or on corrupt latest copy', async () => {
		const old = manifest(new Date(now - 31 * 86400000).toISOString()); const store = fakeStore([old]);
		await expect(enforceRetention(store, config, old, now)).rejects.toMatchObject({ stage: 'retention' });
		expect(store.remove).not.toHaveBeenCalled();
	});
	it('reports deletion failure loudly after upload rather than green success', async () => {
		const recent = manifest(now.toISOString()); const old = manifest(new Date(now - 31 * 86400000).toISOString(), '2');
		const store = fakeStore([recent, old]); store.remove.mockRejectedValue(Error('retention unavailable'));
		await expect(enforceRetention(store, config, recent, now)).rejects.toThrow();
	});
});

describe('independent freshness and alerts', () => {
	it('checks authenticated object checksum metadata without downloading ciphertext every hour', async () => {
		const fresh = manifest(now.toISOString()); const store = fakeStore([fresh]);
		expect((await checkFreshness(store, config, { now })).stage).toBe('recovery');
		expect(store.head).toHaveBeenCalledWith(`${config.prefix}${fresh.id}/payload.sql.gz.age`);
		expect(store.get.mock.calls.every(([key]) => key.endsWith('/complete.json'))).toBe(true);
	});
	it('fails closed on missing or mismatched server checksum metadata', async () => {
		const fresh = manifest(now.toISOString()); const store = fakeStore([fresh]);
		store.head.mockResolvedValue({ bytes: ciphertext.length });
		await expect(checkFreshness(store, config, { now })).rejects.toMatchObject({ stage: 'integrity' });
		store.head.mockResolvedValue({ bytes: ciphertext.length, sha256: '0'.repeat(64) });
		await expect(checkFreshness(store, config, { now })).rejects.toMatchObject({ stage: 'integrity' });
	});
	it('alerts on monitor setup/credentials failure before a freshness check can run', async () => {
		const alert = vi.fn(async () => {}); const store = fakeStore(); store.preflight.mockRejectedValue(Error('synthetic credential denial'));
		const event = await monitorOnce({ prepare: async () => ({ store, config }), alert, now });
		expect(event.stage).toBe('internal'); expect(alert).toHaveBeenCalledWith(event); expect(store.list).not.toHaveBeenCalled();
	});
	it('detects absent completion, skipped schedules, and stale payload despite green runner', async () => {
		expect((await checkFreshness(fakeStore(), config, { now })).stage).toBe('missing');
		const stale = manifest(new Date(now - 27 * 3600000).toISOString());
		expect((await checkFreshness(fakeStore([stale]), config, { now })).stage).toBe('stale');
	});
	it('verifies ciphertext and notices recovery; incomplete upload cannot count as fresh', async () => {
		const fresh = manifest(now.toISOString()); const store = fakeStore([fresh]);
		expect((await checkFreshness(store, config, { now })).stage).toBe('recovery');
		store.map.delete(`${config.prefix}${fresh.id}/payload.sql.gz.age`);
		await expect(checkFreshness(store, config, { now })).rejects.toThrow();
	});
	it('bounds webhook failures and sends only a safe, stable event contract', async () => {
		const fetchImpl = vi.fn(async () => new Response('secret error', { status: 503 }));
		await expect(notify({ stage: 'export' }, { env: { ...env, BACKUP_ALERT_WEBHOOK_URL: 'https://alerts.example.invalid/synthetic' }, fetchImpl })).rejects.toMatchObject({ stage: 'alert-delivery' });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
		expect(body.stage).toBe('export'); expect(body.deduplicationKey).toBe('moderaty-backup:synthetic:export');
		expect(body).not.toHaveProperty('error');
	});
	it('rejects unapproved/insecure webhook config', async () => {
		const fetchImpl = vi.fn();
		await expect(notify({ stage: 'export' }, { env: { ...env, BACKUP_ALERT_WEBHOOK_URL: 'http://example.invalid' }, fetchImpl })).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('S3 adapter boundaries', () => {
	it('uses authenticated HEAD with full-object SHA-256; rejects missing/composite checksums', async () => {
		const result = { ContentLength: ciphertext.length, ChecksumSHA256: Buffer.from(sha256(ciphertext), 'hex').toString('base64'), ChecksumType: 'FULL_OBJECT', ServerSideEncryption: 'AES256' };
		const runTool = vi.fn(async () => Buffer.from(JSON.stringify(result))); const store = s3Store(config, { runTool });
		expect(await store.head(`${config.prefix}fixture/payload.sql.gz.age`)).toEqual({ bytes: ciphertext.length, sha256: sha256(ciphertext) });
		expect(runTool.mock.calls[0][1]).toContain('head-object'); expect(runTool.mock.calls[0][1]).toContain('ENABLED');
		result.ChecksumType = 'COMPOSITE';
		await expect(store.head(`${config.prefix}fixture/payload.sql.gz.age`)).rejects.toMatchObject({ stage: 'integrity' });
	});
	it.each(['Enabled', 'Suspended'])('rejects versioning %s because versionless deletion cannot enforce retention', async (Status) => {
		const runTool = vi.fn(async (_cmd, args) => {
			if (args[0] === '--version') return Buffer.from('aws-cli/2.37.8 Python/3');
			if (args[1] === 'get-public-access-block') return Buffer.from(JSON.stringify({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
			if (args[1] === 'get-bucket-ownership-controls') return Buffer.from(JSON.stringify({ OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } }));
			return Buffer.from(JSON.stringify({ Status }));
		});
		await expect(s3Store(config, { runTool }).preflight()).rejects.toThrow('versioning');
	});
	it('rejects non-private buckets before exporting and fixes endpoint/account/region boundaries', async () => {
		const runTool = vi.fn().mockResolvedValueOnce(Buffer.from('aws-cli/2.37.8 Python/3')).mockResolvedValueOnce(Buffer.from('{"PublicAccessBlockConfiguration": {"BlockPublicAcls":false}}'));
		const store = s3Store(config, { runTool, env: { AWS_ENDPOINT_URL: 'https://unapproved.invalid' } });
		await expect(store.preflight()).rejects.toThrow('public access');
		expect(runTool.mock.calls[1][2].env).not.toHaveProperty('AWS_ENDPOINT_URL');
		expect(runTool.mock.calls[1][1]).toContain(config.owner);
		await expect(store.put(`${config.prefix}raw.sql`, Buffer.from('plaintext'), 'text/plain')).rejects.toThrow('payload');
	});
});
