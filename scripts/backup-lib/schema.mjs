import { DatabaseSync, constants as C } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, checkExpressions, sqlTokens, withoutOptimizerStatistics } from './sql.mjs';
import { BackupError, MAX_BYTES, sha256 } from './common.mjs';

const META = fileURLToPath(new URL('../../drizzle/meta/', import.meta.url));
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const sorted = (items) => [...items].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const migrationOrder = (items) => [...items].sort((a, b) => a.hash.localeCompare(b.hash));
const defaultValue = (value) => value == null ? null : String(value).replace(/^\((.*)\)$/s, '$1');
const fail = () => { throw new BackupError('validation', 'Dump failed integrity, schema or migration validation; contents are suppressed.'); };

export function loadContract(metaDir = META) {
	const journal = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf8'));
	const entries = journal.entries;
	if (!entries?.length) fail();
	const index = String(entries.at(-1).idx).padStart(4, '0');
	const snapshotBytes = readFileSync(join(metaDir, `${index}_snapshot.json`));
	return {
		snapshot: JSON.parse(snapshotBytes),
		version: entries.at(-1).tag,
		schemaHash: sha256(snapshotBytes),
		migrations: entries.map((entry) => ({ hash: sha256(readFileSync(join(metaDir, '..', `${entry.tag}.sql`))), when: entry.when }))
	};
}

function validateTables(db, snapshot) {
	const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").all().map((row) => row.name);
	if (!same(sorted(tables), sorted([...Object.keys(snapshot.tables), '__drizzle_migrations']))) fail();
	for (const table of Object.values(snapshot.tables)) {
		const columns = db.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all();
		if (!same(sorted(columns.map((c) => c.name)), sorted(Object.keys(table.columns)))) fail();
		const composite = Object.values(table.compositePrimaryKeys ?? {})[0]?.columns ?? [];
		for (const actual of columns) {
			const expected = table.columns[actual.name];
			const pk = expected.primaryKey ? 1 : Math.max(0, composite.indexOf(actual.name) + 1);
			if (actual.type.toLowerCase() !== expected.type.toLowerCase() || !!actual.notnull !== expected.notNull || actual.pk !== pk || actual.hidden !== 0 || defaultValue(actual.dflt_value) !== defaultValue(expected.default)) fail();
		}
		const allIndexes = db.prepare(`PRAGMA index_list(${quote(table.name)})`).all();
		// Current Drizzle contract expresses uniqueness through named indexes/PKs.
		if (allIndexes.some((i) => i.origin === 'u') || Object.keys(table.uniqueConstraints ?? {}).length) fail();
		const indexes = allIndexes.filter((i) => i.origin === 'c');
		if (!same(sorted(indexes.map((i) => i.name)), sorted(Object.keys(table.indexes)))) fail();
		for (const index of indexes) {
			const expected = table.indexes[index.name];
			const columns = db.prepare(`PRAGMA index_info(${quote(index.name)})`).all().map((c) => c.name);
			if (!!index.unique !== expected.isUnique || index.partial !== 0 || !same(columns, expected.columns)) fail();
		}
		const schemaSql = db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(table.name).sql;
		const actualConstraints = checkExpressions(schemaSql);
		const expectedChecks = Object.values(table.checkConstraints ?? {}).map((c) => canonical(sqlTokens(c.value)));
		if (!same(sorted(actualConstraints.checks), sorted(expectedChecks)) || actualConstraints.autoIncrement !== Object.values(table.columns).some((c) => c.autoincrement)) fail();
		const actualFks = db.prepare(`PRAGMA foreign_key_list(${quote(table.name)})`).all().map((f) => [f.table, f.from, f.to, f.on_update.toLowerCase(), f.on_delete.toLowerCase()].join('|'));
		const expectedFks = Object.values(table.foreignKeys ?? {}).flatMap((f) => f.columnsFrom.map((column, i) => [f.tableTo, column, f.columnsTo[i], f.onUpdate.toLowerCase(), f.onDelete.toLowerCase()].join('|')));
		if (!same(sorted(actualFks), sorted(expectedFks))) fail();
	}
	// This application's contract has no views, triggers or virtual tables.
	// Reject unsupported additions instead of claiming untested coverage.
	if (db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger','view')").all().length || Object.keys(snapshot.views ?? {}).length) fail();
}

export function validateDump(dump, contract = loadContract(), inspect = () => {}) {
	if (!Buffer.isBuffer(dump)) dump = Buffer.from(dump);
	const sql = new TextDecoder('utf-8', { fatal: true }).decode(dump);
	if (!dump.length || dump.length > MAX_BYTES || !/\bBEGIN TRANSACTION;/.test(sql) || !/COMMIT;\s*$/.test(sql)) fail();
	const db = new DatabaseSync(':memory:', { enableLoadExtension: false, enableDoubleQuotedStringLiterals: false });
	try {
		db.exec('PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF;');
		db.setAuthorizer((action, a, b, database) => {
			if (database && database !== 'main') return C.SQLITE_DENY;
			if (action === C.SQLITE_FUNCTION) return ['replace', 'char'].includes(b?.toLowerCase()) ? C.SQLITE_OK : C.SQLITE_DENY;
			if (action === C.SQLITE_PRAGMA) return a === 'foreign_keys' && ['off', 'on', '0', '1'].includes(b?.toLowerCase()) ? C.SQLITE_OK : C.SQLITE_DENY;
			if ([C.SQLITE_CREATE_TABLE, C.SQLITE_CREATE_INDEX, C.SQLITE_INSERT, C.SQLITE_READ, C.SQLITE_TRANSACTION, C.SQLITE_REINDEX].includes(action)) return C.SQLITE_OK;
			if (action === C.SQLITE_UPDATE && ['sqlite_master', 'sqlite_schema'].includes(a)) return C.SQLITE_OK;
			if (action === C.SQLITE_DELETE && a === 'sqlite_sequence') return C.SQLITE_OK;
			return C.SQLITE_DENY;
		});
		db.exec(withoutOptimizerStatistics(sql));
		db.setAuthorizer(null);
		if (db.isTransaction) fail();
		const integrity = db.prepare('PRAGMA integrity_check').all();
		if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail();
		validateTables(db, contract.snapshot);
		const migrations = db.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at').all();
		if (!same(migrationOrder(migrations.map((m) => ({ hash: m.hash, when: Number(m.created_at) }))), migrationOrder(contract.migrations))) fail();
		inspect(db);
		return { version: contract.version, schemaHash: contract.schemaHash };
	} catch { fail(); }
	finally { db.close(); }
}
