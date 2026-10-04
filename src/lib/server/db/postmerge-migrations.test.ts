import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, expect, test } from 'vitest';

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
const journal = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const original64: Entry = { idx: 64, version: '6', when: 1791063231735, tag: '0064_cron_workload_fairness', breakpoints: true };
const folders: string[] = [];
const clients: Client[] = [];

function migrationFolder(entries: Entry[]) {
	const folder = mkdtempSync(join(tmpdir(), 'moderaty-merged-migrations-'));
	folders.push(folder);
	mkdirSync(join(folder, 'meta'));
	writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
	for (const entry of entries) {
		writeFileSync(join(folder, `${entry.tag}.sql`), readFileSync(new URL(`../../../../drizzle/${entry.tag}.sql`, import.meta.url)));
	}
	return folder;
}

async function database() {
	const client = createClient({ url: 'file::memory:' });
	clients.push(client);
	await client.executeMultiple("CREATE TABLE comments (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL DEFAULT 'channel', status TEXT NOT NULL); INSERT INTO comments (id, status) VALUES ('legacy', 'restoring');");
	return client;
}

async function apply(client: Client, entries: Entry[]) {
	await migrate(drizzle(client), { migrationsFolder: migrationFolder(entries) });
}

async function expectRecorded(client: Client) {
	const hashes = (await client.execute('SELECT hash FROM __drizzle_migrations')).rows.map((row) => row.hash);
	for (const entry of journal.entries.filter((entry: Entry) => entry.idx >= 64)) {
		const hash = createHash('sha256').update(readFileSync(new URL(`../../../../drizzle/${entry.tag}.sql`, import.meta.url))).digest('hex');
		expect(hashes).toContain(hash);
	}
	const hash64 = createHash('sha256').update(readFileSync(new URL('../../../../drizzle/0064_cron_workload_fairness.sql', import.meta.url))).digest('hex');
	expect(hashes.filter((hash) => hash === hash64)).toHaveLength(1);
}

afterEach(() => {
	for (const client of clients.splice(0)) client.close();
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

test('new migration SQL stays free of explanatory comment blocks before deployment hashes it', () => {
	for (const entry of journal.entries.filter((entry: Entry) => entry.idx >= 66)) {
		expect(readFileSync(new URL(`../../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8')).not.toMatch(/^--(?!>)/m);
	}
});

test('the combined journal creates the scheduler on a fresh upgrade and preserves legacy intent', async () => {
	const client = await database();
	await apply(client, journal.entries.filter((entry: Entry) => entry.idx >= 64));
	await client.execute('INSERT INTO cron_workload_state (id) VALUES (1)');
	expect((await client.execute('SELECT * FROM cron_workload_state')).rows).toEqual([{ id: 1, next_workload: 'preview' }]);
	expect((await client.execute('SELECT id, status, restore_intent_id, human_dispatch_token, human_dispatch_state FROM comments')).rows).toEqual([{
		id: 'legacy', status: 'restoring', restore_intent_id: null, human_dispatch_token: null, human_dispatch_state: null
	}]);
	expect((await client.execute('SELECT * FROM welcome_discovery')).rows).toEqual([]);
	await expectRecorded(client);
});

test('a database already at 0065 repairs the omitted scheduler migration and records its actual replay', async () => {
	const client = await database();
	await apply(client, journal.entries.filter((entry: Entry) => entry.idx === 65));
	await apply(client, journal.entries.filter((entry: Entry) => entry.idx >= 64));
	await client.execute('INSERT INTO cron_workload_state (id) VALUES (1)');
	await expect(client.execute("INSERT INTO cron_workload_state VALUES (2, 'live')")).rejects.toThrow(/CHECK/);
	await expect(client.execute("UPDATE cron_workload_state SET next_workload = 'unknown'")).rejects.toThrow(/CHECK/);
	await expectRecorded(client);
	await apply(client, journal.entries.filter((entry: Entry) => entry.idx >= 64));
	expect((await client.execute('SELECT * FROM cron_workload_state')).rows).toEqual([{ id: 1, next_workload: 'preview' }]);
	expect((await client.execute('PRAGMA integrity_check')).rows).toEqual([{ integrity_check: 'ok' }]);
});

test('repair preserves an existing scheduler turn and the metadata chain includes both merged schemas', async () => {
	const client = await database();
	await apply(client, [original64]);
	await client.execute("INSERT INTO cron_workload_state VALUES (1, 'live')");
	await apply(client, journal.entries.filter((entry: Entry) => entry.idx >= 64));
	expect((await client.execute('SELECT * FROM cron_workload_state')).rows).toEqual([{ id: 1, next_workload: 'live' }]);
	await expectRecorded(client);
	expect(journal.entries.find((entry: Entry) => entry.idx === 64)).toEqual(original64);
	const snapshot64 = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/0064_snapshot.json', import.meta.url), 'utf8'));
	const snapshot65 = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/0065_snapshot.json', import.meta.url), 'utf8'));
	expect(snapshot65.prevId).toBe(snapshot64.id);
	expect(snapshot65.tables.cron_workload_state).toEqual(snapshot64.tables.cron_workload_state);
});
