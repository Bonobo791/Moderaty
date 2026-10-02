// Synthetic-only fixtures; no production identities or secret material.
import { loadContract } from './schema.mjs';
import { sha256 } from './common.mjs';
const q = (v) => `"${v.replaceAll('"', '""')}"`;
export const simpleContract = {
	version: '0000_fixture', schemaHash: sha256('synthetic schema'),
	migrations: [{ hash: sha256('synthetic migration'), when: 1 }],
	snapshot: { tables: {
		parent: { name: 'parent', columns: { id: { name: 'id', type: 'text', notNull: true, primaryKey: true }, label: { name: 'label', type: 'text', notNull: false, primaryKey: false } }, indexes: {}, foreignKeys: {} },
		child: { name: 'child', columns: { id: { name: 'id', type: 'integer', notNull: true, primaryKey: true }, parent_id: { name: 'parent_id', type: 'text', notNull: true, primaryKey: false } }, indexes: { child_parent_idx: { name: 'child_parent_idx', columns: ['parent_id'], isUnique: false } }, foreignKeys: { parent_fk: { tableTo: 'parent', columnsFrom: ['parent_id'], columnsTo: ['id'], onUpdate: 'no action', onDelete: 'cascade' } } }
	}, views: {} }
};
export function syntheticDump(contract = simpleContract, data = true) {
	const statements = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
	for (const table of Object.values(contract.snapshot.tables)) {
		const parts = Object.values(table.columns).map((c) => `${q(c.name)} ${c.type}${c.primaryKey ? ' PRIMARY KEY' : ''}${c.autoincrement ? ' AUTOINCREMENT' : ''}${c.notNull ? ' NOT NULL' : ''}${c.default !== undefined ? ` DEFAULT ${typeof c.default === 'string' ? c.default : JSON.stringify(c.default)}` : ''}`);
		for (const p of Object.values(table.compositePrimaryKeys ?? {})) parts.push(`PRIMARY KEY (${p.columns.map(q).join(',')})`);
		for (const f of Object.values(table.foreignKeys ?? {})) parts.push(`FOREIGN KEY (${f.columnsFrom.map(q).join(',')}) REFERENCES ${q(f.tableTo)} (${f.columnsTo.map(q).join(',')}) ON UPDATE ${f.onUpdate} ON DELETE ${f.onDelete}`);
		for (const c of Object.values(table.checkConstraints ?? {})) parts.push(`CONSTRAINT ${q(c.name)} CHECK (${c.value})`);
		statements.push(`CREATE TABLE ${q(table.name)} (${parts.join(',')});`);
		for (const i of Object.values(table.indexes)) statements.push(`CREATE ${i.isUnique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${q(table.name)} (${i.columns.map(q).join(',')});`);
	}
	statements.push('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);');
	for (const m of contract.migrations) statements.push(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${m.hash}', ${m.when});`);
	if (data && contract === simpleContract) statements.push("INSERT INTO parent VALUES ('p1','synthetic private row');", "INSERT INTO child VALUES (1,'p1');");
	statements.push('COMMIT;');
	return Buffer.from(`${statements.join('\n')}\n`);
}
export const fullContract = () => loadContract();
