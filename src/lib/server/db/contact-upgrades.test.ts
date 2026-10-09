import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const folder = join(root, 'drizzle');
const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
const sqlFile = (tag: string) => readFileSync(join(folder, tag + '.sql'), 'utf8');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('keeps main migration identities and snapshot ancestry unchanged', () => {
	expect(hash(sqlFile('0059_feedback_digests_pending_idx'))).toBe('899c27bd3f8245dbdb51b7c4011676e53edb313c3edbcf337d4401e5d18b556c');
	expect(hash(sqlFile('0060_preview_attempted_at'))).toBe('24d124bc6099f80457dbde07f69b0429eeb3c3853846aae9c50b1808c6ce7e47');
	expect(journal.entries[59]).toMatchObject({ idx: 59, tag: '0059_feedback_digests_pending_idx', when: 1790943374789 });
	expect(journal.entries[60]).toMatchObject({ idx: 60, tag: '0060_preview_attempted_at', when: 1790965471083 });
	expect(journal.entries[61]).toMatchObject({ idx: 61, tag: '0061_contact_message_delivery' });
	expect(journal.entries[61].when).toBeGreaterThan(journal.entries[60].when);
	const snapshot = JSON.parse(readFileSync(join(folder, 'meta/0061_snapshot.json'), 'utf8'));
	expect(snapshot.prevId).toBe('17ae629c-3fe8-4011-a60c-aa9c3b7dc69d');
	expect(snapshot.tables.feedback_digests.columns.attempted_at).toMatchObject({ type: 'text', notNull: false });
	expect(snapshot.tables.feedback_digests.indexes.feedback_digests_pending_idx).toBeDefined();
});

test.each([58, 60])('upgrades the synthetic base at %i through the real journal exactly once', async (base) => {
	const dir = mkdtempSync(join(tmpdir(), 'contact-upgrade-'));
	const url = 'file:' + join(dir, 'fixture.db');
	const client = createClient({ url });
	try {
		await client.executeMultiple(`
			CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC);
			CREATE TABLE feedback_digests (id INTEGER PRIMARY KEY, status TEXT NOT NULL, marker TEXT);
			CREATE TABLE contact_submissions (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, verification_token TEXT NOT NULL, expires_at TEXT NOT NULL, verified_at TEXT, consent_text TEXT NOT NULL, ip TEXT NOT NULL, user_agent TEXT NOT NULL, created_at TEXT NOT NULL);
			CREATE TABLE comments (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, status TEXT NOT NULL);
			CREATE TABLE channels (id TEXT PRIMARY KEY);
			CREATE TABLE channel_allowed_handles (id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, handle TEXT NOT NULL, created_at TEXT NOT NULL);
			INSERT INTO channel_allowed_handles VALUES (1, 'channel', 'legacy_handle', '2026-10-01T00:00:00Z');
			INSERT INTO comments VALUES ('legacy-comment', 'channel', 'restoring');
			INSERT INTO feedback_digests VALUES (1, 'dry-run-pending', 'preserve pending'), (2, 'completed', 'preserve completed');
			INSERT INTO contact_submissions VALUES (1, 'pending@example.com', 'Pending', 'pending', 'pending-token', '2026-10-10T00:00:00.000Z', NULL, 'original consent', '127.0.0.1', 'synthetic', '2026-10-01T00:00:00.000Z');
			INSERT INTO contact_submissions VALUES (2, 'verified@example.com', 'Verified', 'verified', 'verified-token', '2026-10-10T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 'original consent', '127.0.0.1', 'synthetic', '2026-10-01T00:00:00.000Z');
		`);
		if (base === 60) {
			await client.executeMultiple(sqlFile('0059_feedback_digests_pending_idx') + '\n' + sqlFile('0060_preview_attempted_at'));
			await client.execute("UPDATE feedback_digests SET attempted_at = '2026-10-02T12:00:00.000Z' WHERE id = 1");
		}
		for (const entry of journal.entries.filter(entry => entry.idx <= base)) {
			await client.execute({ sql: 'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)', args: [hash(sqlFile(entry.tag)), entry.when] });
		}
		await migrate(drizzle(client), { migrationsFolder: folder });
		expect((await client.execute('SELECT handle FROM channel_allowed_handles')).rows).toEqual([{ handle: 'legacy_handle' }]);
		expect((await client.execute('SELECT id, status, restore_intent_id FROM comments')).rows).toEqual([
			{ id: 'legacy-comment', status: 'restoring', restore_intent_id: null }
		]);
		expect((await client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations')).rows[0].n).toBe(journal.entries.length);
		expect((await client.execute('SELECT id, status, marker, attempted_at FROM feedback_digests ORDER BY id')).rows).toEqual([
			{ id: 1, status: 'dry-run-pending', marker: 'preserve pending', attempted_at: base === 60 ? '2026-10-02T12:00:00.000Z' : null },
			{ id: 2, status: 'completed', marker: 'preserve completed', attempted_at: null }
		]);
		expect((await client.execute('SELECT id, status, consent_text, message, notification_due_at, notification_claim, notification_sent_at FROM contact_submissions ORDER BY id')).rows).toEqual([
			{ id: 1, status: 'pending', consent_text: 'original consent', message: null, notification_due_at: null, notification_claim: null, notification_sent_at: null },
			{ id: 2, status: 'verified', consent_text: 'original consent', message: null, notification_due_at: null, notification_claim: null, notification_sent_at: null }
		]);
		const before = (await client.execute('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')).rows;
		await migrate(drizzle(client), { migrationsFolder: folder });
		expect((await client.execute('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')).rows).toEqual(before);
		expect((await client.execute("SELECT sql FROM sqlite_master WHERE name='feedback_digests_pending_idx'")).rows[0].sql).toContain("'dry-run-pending'");
		expect((await client.execute("PRAGMA index_info('contact_submissions_notification_due_idx')")).rows.map(row => row.name)).toEqual(['notification_due_at']);
		expect((await client.execute('PRAGMA integrity_check')).rows[0]).toEqual({ integrity_check: 'ok' });
		expect((await client.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
		const output = execFileSync(process.execPath, ['scripts/verify-migrations.mjs'], { cwd: root, env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: '' }, encoding: 'utf8' });
		expect(output).toContain('verify-migrations: PASS');
	} finally {
		client.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
