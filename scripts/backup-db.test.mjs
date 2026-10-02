import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup } from './backup-db.mjs';
import { exportDump } from './backup-lib/export.mjs';
import { validateDump } from './backup-lib/schema.mjs';
import { recipientConfig, encryptDump } from './backup-lib/encryption.mjs';
import { simpleContract, syntheticDump, fullContract } from './backup-lib/fixtures.mjs';

const env = { BACKUP_SCOPE: 'synthetic', BACKUP_AGE_RECIPIENT: `age1${'a'.repeat(58)}` };
const encrypt = vi.fn(async () => Buffer.from(`age-encryption.org/v1\n${'cipher'.repeat(30)}`));
function options(extra = {}) { return { env, contract: simpleContract, exportData: async () => ({ dump: syntheticDump(), tool: 'turso-http-dump-v1' }), encrypt, ...extra }; }

describe('encrypted backup', () => {
	it('writes only encrypted payload and safe metadata with collision-safe names', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));
		try {
			const a = await backup('fixture', dir, options()); const b = await backup('fixture', dir, options());
			expect(a.id).not.toBe(b.id);
			expect(readdirSync(join(dir, a.id)).sort()).toEqual(['complete.json', 'payload.sql.gz.age']);
			expect(readFileSync(join(dir, a.id, 'payload.sql.gz.age')).toString()).not.toContain('synthetic private row');
			expect(JSON.stringify(a)).not.toContain('synthetic private row');
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	it('fails closed before export on missing encryption or remote activation', async () => {
		const exportData = vi.fn();
		await expect(backup('fixture', '--upload', options({ exportData }))).rejects.toMatchObject({ stage: 'configuration' });
		await expect(backup('fixture', '/unused', options({ env: {}, exportData }))).rejects.toMatchObject({ stage: 'configuration' });
		expect(exportData).not.toHaveBeenCalled();
	});
	it('does not write output when encryption fails or cancellation arrives', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));
		try {
			await expect(backup('fixture', dir, options({ encrypt: async () => { throw Error('synthetic failure'); } }))).rejects.toThrow();
			await expect(backup('fixture', dir, options({ signal: AbortSignal.abort() }))).rejects.toThrow();
			expect(readdirSync(dir)).toEqual([]);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	it('rejects age plugin/private-key configuration and plaintext output', async () => {
		expect(() => recipientConfig({ BACKUP_AGE_RECIPIENT: 'AGE-SECRET-KEY-synthetic' })).toThrow();
		const runTool = vi.fn().mockResolvedValueOnce(Buffer.from('v1.2.1')).mockResolvedValueOnce(syntheticDump());
		await expect(encryptDump(syntheticDump(), env.BACKUP_AGE_RECIPIENT, { runTool })).rejects.toMatchObject({ stage: 'encryption' });
	});
});

describe('export authentication and safe errors', () => {
	it('requires scoped CI credentials before any command/network request', async () => {
		const fetchImpl = vi.fn(); const runTool = vi.fn();
		await expect(exportDump('fixture', { env: { CI: 'true' }, fetchImpl, runTool })).rejects.toMatchObject({ stage: 'authentication' });
		expect(fetchImpl).not.toHaveBeenCalled(); expect(runTool).not.toHaveBeenCalled();
	});
	it('supports authenticated local CLI without env token and rejects login text with exit zero', async () => {
		const runTool = vi.fn().mockResolvedValueOnce(Buffer.from('turso version v1.0.31')).mockResolvedValueOnce(Buffer.from('https://fixture-example.turso.io')).mockResolvedValueOnce(syntheticDump());
		expect((await exportDump('fixture', { env: {}, runTool })).dump).toEqual(syntheticDump());
		const bad = vi.fn().mockResolvedValueOnce(Buffer.from('v1.0.31')).mockResolvedValueOnce(Buffer.from('Please login: SECRET'));
		await expect(exportDump('fixture', { env: {}, runTool: bad })).rejects.toMatchObject({ stage: 'authentication' });
		expect(bad).toHaveBeenCalledTimes(2);
	});
	const http = { CI: 'true', BACKUP_DATABASE_URL: 'https://fixture-example.turso.io', BACKUP_EXPECTED_DATABASE_HOST: 'fixture-example.turso.io', BACKUP_DATABASE_AUTH_TOKEN: 'synthetic' };
	it.each([401, 403, 429, 500])('rejects HTTP %i without leaking body or token', async (status) => {
		await expect(exportDump('fixture', { env: http, fetchImpl: async () => new Response('secret row', { status }) })).rejects.toThrow('source output is suppressed');
	});
	it('rejects identity mismatch and redirects and returns successful bytes for validation', async () => {
		const fetchImpl = vi.fn(async () => new Response(syntheticDump()));
		await expect(exportDump('other', { env: http, fetchImpl })).rejects.toMatchObject({ stage: 'configuration' });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect((await exportDump('fixture', { env: http, fetchImpl })).dump).toEqual(syntheticDump());
		expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
	});
});

describe('restorable schema contract', () => {
	it('imports empty and populated databases and checks real relational data', () => {
		expect(validateDump(syntheticDump(simpleContract, false), simpleContract).version).toBe('0000_fixture');
		validateDump(syntheticDump(), simpleContract, (db) => { expect(db.prepare('SELECT count(*) AS n FROM child JOIN parent ON child.parent_id=parent.id').get().n).toBe(1); });
	});
	it('restores upstream dump expressions for newline, carriage return, quotes and blobs', () => {
		const sql = syntheticDump().toString().replace("'synthetic private row'", "replace(replace('line\\nquote''s\\r','\\n',char(10)),'\\r',char(13))");
		validateDump(sql, simpleContract, (db) => expect(db.prepare('SELECT label FROM parent').get().label).toBe("line\nquote's\r"));
	});
	it('accepts and preserves raw optimizer statistics without executing them in the validator', () => {
		const sql = syntheticDump().toString().replace('COMMIT;', "ANALYZE sqlite_schema; INSERT INTO sqlite_stat1 VALUES('parent','sqlite_autoindex_parent_1','1 1'); INSERT INTO sqlite_stat4 VALUES('parent','idx',1,1,1,X'ABCD'); COMMIT;");
		expect(validateDump(sql, simpleContract).version).toBe(simpleContract.version);
	});
	it('rejects a required CHECK hidden only in a SQL comment', () => {
		const contract = fullContract(); const dump = syntheticDump(contract, false).toString();
		const constraint = ',CONSTRAINT "channels_org_requires_owner" CHECK ("channels"."org_id" IS NOT NULL OR "channels"."user_id" IS NULL)';
		expect(dump).toContain(constraint);
		expect(() => validateDump(dump.replace(constraint, `/* ${constraint} */`), contract)).toThrow();
	});
	it('preserves semicolons and optimizer-looking SQL inside literal row values', () => {
		const text = "literal; INSERT INTO sqlite_stat4 VALUES(1); -- comment";
		const dump = syntheticDump().toString().replace('synthetic private row', text);
		validateDump(dump, simpleContract, (db) => expect(db.prepare('SELECT label FROM parent').get().label).toBe(text));
	});
	it.each([
		"INSERT INTO sqlite_stat1 THIS IS NOT SQL;",
		"INSERT INTO sqlite_stat1 SELECT load_extension('/tmp/untrusted');",
		"INSERT INTO sqlite_stat1 VALUES('parent','idx',load_extension('/tmp/untrusted'));",
		"'analyze' sqlite_schema;",
		"INSERT INTO sqlite_stat1 VALUES('parent','idx',1 2);",
		"INSERT INTO sqlite_stat4 VALUES('parent','idx',1,1,1,X 'ABCD');",
		"INSERT INTO sqlite_stat1 VALUES '(' 'parent','idx',1 ')' ;"
	])('rejects malformed or executable optimizer-stat content', (statement) => {
		expect(() => validateDump(syntheticDump().toString().replace('COMMIT;', `${statement} COMMIT;`), simpleContract)).toThrow();
	});
	it('validates the complete current repository schema and all migration hashes', () => {
		const contract = fullContract();
		expect(validateDump(syntheticDump(contract, false), contract).schemaHash).toBe(contract.schemaHash);
	});
	it.each(['', 'login CREATE TABLE', 'HTTP 401 CREATE TABLE', 'BEGIN TRANSACTION;CREATE TABLE a(id);', 'BEGIN TRANSACTION;COMMIT;'])('rejects incomplete or misleading output %s', (sql) => {
		expect(() => validateDump(sql, simpleContract)).toThrow();
	});
	it.each([
		(s) => s.replace('CREATE TABLE "parent"', 'CREATE TABLE "wrong"'),
		(s) => s.replace('CREATE INDEX "child_parent_idx" ON "child" ("parent_id");', ''),
		(s) => s.replace("(1,'p1')", "(1,'missing')"),
		(s) => s.replace(simpleContract.migrations[0].hash, 'bad'),
		(s) => s.replace('\"label\" text', '\"label\" text UNIQUE'),
		(s) => s.replace('\"label\" text', '\"label\" text CHECK(label IS NOT NULL)'),
		(s) => s.replace('\"label\" text', '\"label\" text DEFAULT 5'),
		(s) => s.replace('integer PRIMARY KEY NOT NULL', 'integer PRIMARY KEY AUTOINCREMENT NOT NULL'),
		(s) => s.replace('COMMIT;', 'CREATE TABLE sqliteXunvalidated(secret TEXT); COMMIT;'),
		(s) => s.replace('COMMIT;', 'ATTACH DATABASE \'/tmp/should-not-exist\' AS bad; COMMIT;'),
		(s) => s.replace('COMMIT;', 'SELECT load_extension(\'bad\'); COMMIT;'),
		(s) => s.replace('COMMIT;', 'PRAGMA writable_schema=ON; COMMIT;')
	])('rejects schema, relational, migration or unsafe SQL drift', (change) => {
		expect(() => validateDump(change(syntheticDump().toString()), simpleContract)).toThrow();
	});
});
