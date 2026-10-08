import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtures = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});

function fixture(sqlFiles) {
	const root = mkdtempSync(join(tmpdir(), 'db-migrate-test-'));
	const env = { ...process.env, TURSO_DATABASE_URL: `file:${join(root, 'test.db')}`, TURSO_AUTH_TOKEN: '' };
	const result = { root, env };
	fixtures.push(result);
	mkdirSync(join(root, 'scripts'));
	mkdirSync(join(root, 'drizzle', 'meta'), { recursive: true });
	symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
	copyFileSync(join(repoRoot, 'package.json'), join(root, 'package.json'));
	copyFileSync(join(repoRoot, 'drizzle.config.ts'), join(root, 'drizzle.config.ts'));
	for (const name of ['netlify-migrate', 'db-preflight', 'db-migrate', 'migration-config', 'verify-migrations']) {
		const source = join(repoRoot, 'scripts', `${name}.mjs`);
		if (existsSync(source)) copyFileSync(source, join(root, 'scripts', `${name}.mjs`));
	}
	const entries = sqlFiles.map((sql, idx) => {
		const tag = `000${idx}_probe`;
		writeFileSync(join(root, 'drizzle', `${tag}.sql`), sql);
		return { idx, version: '6', when: idx + 1, tag, breakpoints: true };
	});
	writeFileSync(join(root, 'drizzle', 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'sqlite', entries }));
	return result;
}

function runMigration({ root, env }, args = []) {
	// Exercise the actual npm command, including its configured entry point.
	return execFileAsync('npm', ['run', 'db:migrate', '--', ...args], { cwd: root, env });
}

async function query({ env }, sql) {
	const client = createClient({ url: env.TURSO_DATABASE_URL });
	try {
		return (await client.execute(sql)).rows;
	} finally {
		client.close();
	}
}

describe('db:migrate', () => {
	it('reports the database error when migration SQL fails after a successful write preflight', async () => {
		const db = fixture(['CREATE TABLE migration_probe (id INTEGER);', 'ALTER TABLE migration_probe ADD id INTEGER;']);
		const { stdout } = await execFileAsync(process.execPath, [join(db.root, 'scripts', 'db-preflight.mjs')], { env: db.env });
		expect(stdout).toContain('credentials accepted and writable');
		const error = await runMigration(db).catch((error) => error);
		expect(error.code).toBe(1);
		expect(error.stderr).toContain('SQLITE_ERROR');
		expect(error.stderr).toContain('duplicate column name: id');
		// Drizzle batches all pending migrations atomically; no partial schema or journal may remain.
		expect(await query(db, "SELECT name FROM sqlite_master WHERE name = 'migration_probe'")).toEqual([]);
		expect(await query(db, 'SELECT hash FROM __drizzle_migrations')).toEqual([]);
	});

	it('applies and verifies the real journal hashes and does not repeat migrations', async () => {
		const sql = ['CREATE TABLE migration_probe (id INTEGER);', 'ALTER TABLE migration_probe ADD value TEXT;'];
		const db = fixture(sql);
		await runMigration(db);
		expect((await query(db, 'PRAGMA table_info(migration_probe)')).map((row) => row.name)).toEqual(['id', 'value']);
		const expected = sql.map((text, index) => ({ hash: createHash('sha256').update(text).digest('hex'), created_at: index + 1 }));
		expect(await query(db, 'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')).toEqual(expected);
		await runMigration(db);
		expect(await query(db, 'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')).toEqual(expected);
		const { stdout } = await execFileAsync(process.execPath, [join(db.root, 'scripts', 'verify-migrations.mjs')], { env: db.env });
		expect(stdout).toContain('PASS — all 2 migrations applied');
	});

	it('surfaces the SQL error through the real deploy gate and stops before verification', async () => {
		const db = fixture(['INSERT INTO missing_migration_table VALUES (1);']);
		const error = await execFileAsync(process.execPath, [join(db.root, 'scripts', 'netlify-migrate.mjs')], {
			cwd: db.root,
			env: { ...db.env, CONTEXT: 'production', MODERATY_MIGRATE_TEST_HOOKS: '' }
		}).catch((error) => error);
		expect(error.code).toBe(1);
		expect(error.stdout).toContain('credentials accepted and writable');
		expect(error.stderr).toContain('no such table: missing_migration_table');
		expect(error.stderr).toContain('db:migrate failed');
		expect(error.stdout + error.stderr).not.toContain('verify-migrations:');
		expect(error.stdout + error.stderr).not.toContain('proceeding with the build');
	});

	it('redacts configured credentials from database error messages', async () => {
		const db = fixture(['INSERT INTO missing_migration_test_credential VALUES (1);']);
		const token = 'migration_test_credential';
		const error = await runMigration({ ...db, env: { ...db.env, TURSO_AUTH_TOKEN: token } }).catch((error) => error);
		expect(error.code).toBe(1);
		expect(error.stderr).toContain('no such table: missing_[REDACTED]');
		expect(error.stdout + error.stderr).not.toContain(token);
	});

	it('redacts URL credentials when the driver normalizes libsql to https', async () => {
		const db = fixture(['CREATE TABLE migration_probe (id INTEGER);']);
		const username = 'migration-test-user';
		const password = 'migration-test-password';
		const error = await runMigration({ ...db, env: {
			...db.env,
			TURSO_DATABASE_URL: `libsql://${username}:${password}@127.0.0.1`,
			TURSO_AUTH_TOKEN: 'migration-test-token'
		} }).catch((error) => error);
		expect(error.code).toBe(1);
		expect(error.stderr).toContain('Request cannot be constructed from a URL that includes credentials');
		expect(error.stderr).toContain('[REDACTED]');
		expect(error.stdout + error.stderr).not.toContain(username);
		expect(error.stdout + error.stderr).not.toContain(password);
	});

	it('redacts the URL authToken that overrides the separate configured token', async () => {
		const db = fixture(['INSERT INTO missing_migration_url_credential VALUES (1);']);
		const token = 'migration_url_credential';
		const error = await runMigration({ ...db, env: {
			...db.env,
			TURSO_DATABASE_URL: `${db.env.TURSO_DATABASE_URL}?authToken=${token}`,
			TURSO_AUTH_TOKEN: 'separate-test-token'
		} }).catch((error) => error);
		expect(error.code).toBe(1);
		expect(error.stderr).toContain('no such table: missing_[REDACTED]');
		expect(error.stdout + error.stderr).not.toContain(token);
	});

	it('rejects a different metadata directory before making database writes', async () => {
		const db = fixture(['CREATE TABLE migration_probe (id INTEGER);']);
		const error = await runMigration(db, [join(db.root, 'drizzle', 'does-not-exist')]).catch((error) => error);
		expect(error.code).toBe(1);
		expect(error.stderr).toContain('metadata directory must be named meta');
		expect(await query(db, "SELECT name FROM sqlite_master WHERE name IN ('migration_probe', '__drizzle_migrations')")).toEqual([]);
	});
});
