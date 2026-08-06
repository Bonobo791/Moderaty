// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { expect, test, vi } from 'vitest';

import { consents, invites, memberships, organizations, users } from './db/schema';
import { seedConsent, seedUser, setupTestDb, testDb, wipeTables } from './testdb';

// Harness self-test (PR #48 review): schema.ts exports the tenant tables from
// Phase A, so createTestDb's hand-written DDL must create them too — every
// Phase B+ fixture seeds orgs/memberships through this helper. Guards the
// table presence AND the constraints the app relies on (personal_for UNIQUE,
// memberships composite PK).
setupTestDb(['consents', 'invites', 'memberships', 'organizations', 'users']);

test('wipeTables empties the given tables on demand (per-property-run freshness)', async () => {
	await seedUser('wipe-me');
	expect(await testDb().db.select().from(users).all()).toHaveLength(1);
	await wipeTables(['users']);
	expect(await testDb().db.select().from(users).all()).toHaveLength(0);
});

// PR #121 review (amazon-q, qodo): caller-provided names are interpolated into
// SQL, so anything that is not an app-schema table must be rejected loudly —
// including names that exist in SQLite but are not ours (a silent
// `DELETE FROM sqlite_sequence` resets every AUTOINCREMENT counter).
test('wipeTables rejects tables outside the app schema loudly', async () => {
	await expect(wipeTables(['sqlite_sequence'])).rejects.toThrow(/unknown table/);
	await expect(wipeTables(['usrers'])).rejects.toThrow(/unknown table/);
});

// PR #121 review (qodo): caller-ordered deletes break the moment a non-cascade
// FK lands in the schema. The wipe must suspend FK enforcement itself, and the
// OFF must precede every DELETE. The ON travels in a SEPARATE execute after
// the multiple: executeMultiple stops at the first failing statement, so an ON
// inside the same batch would be skipped by a failed DELETE (PR #122 review,
// coderabbit) — and libsql's batch() runs transactionally, where the pragma is
// a no-op, so executeMultiple remains the only harness that honors the OFF.
test('wipeTables suspends FK enforcement around the deletes', async () => {
	const multiSpy = vi.spyOn(testDb().client, 'executeMultiple');
	const execSpy = vi.spyOn(testDb().client, 'execute');
	try {
		await wipeTables(['users']);
		expect(multiSpy).toHaveBeenCalledTimes(1);
		const sql = multiSpy.mock.calls[0][0] as string;
		const off = sql.indexOf('PRAGMA foreign_keys = OFF');
		const del = sql.indexOf('DELETE FROM users');
		expect(off).toBeGreaterThanOrEqual(0);
		expect(off).toBeLessThan(del);
		expect(sql).not.toContain('PRAGMA foreign_keys = ON');
		expect(execSpy).toHaveBeenCalledWith('PRAGMA foreign_keys = ON');
		// The ON must be issued after the multiple, never before.
		expect(execSpy.mock.invocationCallOrder[0]).toBeGreaterThan(multiSpy.mock.invocationCallOrder[0]);
	} finally {
		multiSpy.mockRestore();
		execSpy.mockRestore();
	}
});

// PR #122 review (coderabbit): a failed DELETE must not leave the shared
// in-memory connection with FK enforcement OFF — later tests would silently
// lose the FK violations the harness exists to catch.
test('wipeTables restores FK enforcement even when a delete fails', async () => {
	const client = testDb().client;
	// Simulate executeMultiple stopping mid-batch: the OFF has already taken
	// effect when the DELETE fails — exactly how the real failure mode leaves
	// the connection (a blanket rejection would never turn FK off at all).
	const spy = vi.spyOn(client, 'executeMultiple').mockImplementation(async () => {
		await client.execute('PRAGMA foreign_keys = OFF');
		throw new Error('disk I/O error');
	});
	try {
		await expect(wipeTables(['users'])).rejects.toThrow('disk I/O error');
	} finally {
		spy.mockRestore();
	}
	const { rows } = await client.execute('PRAGMA foreign_keys');
	expect(Number(rows[0][0])).toBe(1);
});

test('createTestDb creates the tenant tables', async () => {
	const tables = await testDb().client.execute(
		"SELECT name FROM sqlite_master WHERE name IN ('organizations','memberships','invites') ORDER BY name"
	);
	expect(tables.rows.map((row) => row.name)).toEqual(['invites', 'memberships', 'organizations']);
});

test('tenant round-trip: org + owner membership + invite persist and read back', async () => {
	await seedUser('user-1');
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'One', personalFor: 'user-1' });
	await testDb().db.insert(memberships).values({ userId: 'user-1', orgId: 'org-1', role: 'owner' });
	await testDb().db.insert(invites).values({
		token: 'tok-1',
		orgId: 'org-1',
		role: 'member',
		createdBy: 'user-1',
		expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
	});
	const org = await testDb().db.select().from(organizations).all();
	const mem = await testDb().db.select().from(memberships).all();
	const inv = await testDb().db.select().from(invites).all();
	expect(org).toMatchObject([{ id: 'org-1', name: 'One', plan: 'free', personalFor: 'user-1' }]);
	expect(mem).toMatchObject([{ userId: 'user-1', orgId: 'org-1', role: 'owner' }]);
	expect(inv).toMatchObject([
		{ token: 'tok-1', orgId: 'org-1', role: 'member', createdBy: 'user-1', expiresAt: expect.any(String) }
	]);
});

test('personal_for UNIQUE and memberships composite PK are enforced', async () => {
	await seedUser('user-1');
	await seedUser('user-2');
	await testDb().db.insert(organizations).values({ id: 'org-1', name: 'One', personalFor: 'user-1' });
	await testDb().db.insert(organizations).values({ id: 'org-2', name: 'Two', personalFor: 'user-2' });
	await testDb().db.insert(memberships).values({ userId: 'user-1', orgId: 'org-1', role: 'owner' });
	// Positive controls: cross memberships must SUCCEED — a PRIMARY KEY on
	// user_id alone would reject these, so they prove the key is composite.
	await testDb().db.insert(memberships).values({ userId: 'user-1', orgId: 'org-2', role: 'member' });
	await testDb().db.insert(memberships).values({ userId: 'user-2', orgId: 'org-1', role: 'member' });
	await expect(
		testDb().db.insert(organizations).values({ id: 'org-3', name: 'Dup', personalFor: 'user-1' })
	).rejects.toThrow();
	await expect(
		testDb().db.insert(memberships).values({ userId: 'user-1', orgId: 'org-1', role: 'member' })
	).rejects.toThrow();
});

// seedConsent must seed the evidentiary defaults a consent row carries — the
// exact checkbox text, IP, and user agent are the audit evidence, and the
// doc version default tracks LEGAL_VERSION-era fixtures.
test('seedConsent seeds the evidentiary defaults', async () => {
	await seedUser('user-1');
	await seedConsent('user-1');
	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toMatchObject([
		{
			userId: 'user-1',
			email: 'user-1@example.com',
			docVersion: 'v1.2',
			checkboxText: 'I agree',
			ip: '127.0.0.1',
			userAgent: 'test',
			marketingOptIn: 0
		}
	]);
	expect(rows[0].createdAt).toEqual(expect.any(String));
});

test('seedConsent honors an explicit createdAt and docVersion override', async () => {
	await seedUser('user-1');
	await seedConsent('user-1', '2020-01-01T00:00:00.000Z', 'v1.1');
	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toMatchObject([{ createdAt: '2020-01-01T00:00:00.000Z', docVersion: 'v1.1' }]);
});
