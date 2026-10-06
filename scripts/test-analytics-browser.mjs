// Run after MODERATY_ADAPTER=node npm run build. Uses only local fixtures.
// Requires Python 3 Playwright and Chromium, matching test-recovery-confirmation.mjs.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { runBrowserProcess } from './browser-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pythonBinary = process.env.PYTHON_BINARY ?? '/usr/bin/python3';
const chromiumBinary = process.env.CHROMIUM_BINARY ?? '/usr/bin/chromium';
assert.ok(path.isAbsolute(pythonBinary), 'PYTHON_BINARY must be an absolute path');
assert.ok(path.isAbsolute(chromiumBinary), 'CHROMIUM_BINARY must be an absolute path');
const fixture = await mkdtemp(path.join(tmpdir(), 'moderaty-analytics-browser-'));
try {
	const client = createClient({ url: 'file:' + path.join(fixture, 'fixture.db') });
	try {
		// Public/login fixture: no users or auth cookies. Satisfies only the real
		// hook's migration-count guard; this does not verify migrations or schema.
		const journal = JSON.parse(await readFile(path.join(root, 'drizzle/meta/_journal.json'), 'utf8'));
		await client.execute('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER)');
		await client.batch(journal.entries.map((entry) => ({
			sql: 'INSERT INTO __drizzle_migrations (id, hash, created_at) VALUES (?, ?, ?)',
			args: [entry.idx, 'synthetic-browser-fixture', entry.when]
		})), 'write');
	} finally {
		client.close();
	}
	const result = await runBrowserProcess(pythonBinary, [path.join(root, 'scripts/test-analytics-browser.py'), root, fixture, process.execPath, chromiumBinary]);
	process.stdout.write(result.stdout ?? '');
	assert.equal(result.error, undefined, 'Python 3 Playwright, Chromium and the Node build must be available');
	assert.equal(result.status, 0, result.stderr);
} finally {
	await rm(fixture, { recursive: true, force: true });
}
