// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { afterEach, expect, test } from 'vitest';

import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

// Behavior test for migration 0026 (contact form opt-in): creates the
// contact_submissions table with its unique verification token and the
// (status, email) resubmission-dedupe index. Pure additive — there is no
// pre-0026 state to preserve.
const MIGRATION = '0026_contact_form_opt_in.sql';

afterEach(closeMigratedDbs);

test('migration 0026 creates contact_submissions with token uniqueness and dedupe index', async () => {
	const client = await applyMigration('', MIGRATION);

	const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_submissions'");
	expect(tables.rows).toHaveLength(1);

	const columns = await client.execute('PRAGMA table_info(contact_submissions)');
	expect(columns.rows.map((row) => String(row.name))).toEqual([
		'id',
		'email',
		'name',
		'status',
		'verification_token',
		'expires_at',
		'verified_at',
		'consent_text',
		'ip',
		'user_agent',
		'created_at'
	]);

	const indexes = await client.execute("PRAGMA index_list('contact_submissions')");
	const names = indexes.rows.map((row) => String(row.name));
	expect(names).toContain('contact_submissions_verification_token_unique');
	expect(names).toContain('contact_submissions_status_email_idx');

	// Default status is 'pending' and created_at is populated by the DB.
	await client.execute(`
		INSERT INTO contact_submissions (email, name, verification_token, expires_at, consent_text, ip, user_agent)
		VALUES ('a@example.com', 'Ann', 'tok-1', '2030-01-01T00:00:00.000Z', 'I opt in', '127.0.0.1', 'test')
	`);
	const row = await client.execute('SELECT status, created_at FROM contact_submissions WHERE verification_token = \'tok-1\'');
	expect(row.rows).toEqual([{ status: 'pending', created_at: expect.any(String) }]);

	// The UNIQUE index is enforced at the database level, not just in app code.
	await expect(
		client.execute(`
			INSERT INTO contact_submissions (email, name, verification_token, expires_at, consent_text, ip, user_agent)
			VALUES ('b@example.com', 'Bob', 'tok-1', '2030-01-01T00:00:00.000Z', 'I opt in', '127.0.0.1', 'test')
		`)
	).rejects.toThrow(/UNIQUE/i);
});
