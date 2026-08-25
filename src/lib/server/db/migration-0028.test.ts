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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { afterEach, expect, test } from 'vitest';

import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

// Behavior test for migration 0028 (one pending contact submission per e-mail):
// the pre-0028 check-then-insert flow only reused UNEXPIRED pending rows, so a
// submission that arrived after the previous pending row expired created a
// SECOND pending row for the same e-mail. The unique index therefore cannot be
// created until those historical duplicates are reconciled — the migration
// keeps the newest pending row per e-mail and drops the rest first.
const MIGRATION = '0028_contact_submissions_pending_email_unique.sql';

afterEach(closeMigratedDbs);

test('migration 0028 dedupes historical pending rows before creating the partial unique index', async () => {
	// Pre-0028 schema (final 0026 shape): no partial unique index on pending.
	const preDdl = `
		CREATE TABLE contact_submissions (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			email TEXT NOT NULL,
			name TEXT NOT NULL,
			status TEXT DEFAULT 'pending' NOT NULL,
			verification_token TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			verified_at TEXT,
			consent_text TEXT NOT NULL,
			ip TEXT NOT NULL,
			user_agent TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE UNIQUE INDEX contact_submissions_verification_token_unique ON contact_submissions (verification_token);
	`;
	// Historical duplicates the old flow could produce: two PENDING rows for
	// 'dup@example.com' (one expired, one fresh), one verified row for the same
	// address, and a pending row for a different address.
	const seedSql = `
		INSERT INTO contact_submissions (id, email, name, status, verification_token, expires_at, consent_text, ip, user_agent)
			VALUES (1, 'dup@example.com', 'Old', 'pending', 'tok-old', '2000-01-01T00:00:00.000Z', 'x', '1.1.1.1', 'test');
		INSERT INTO contact_submissions (id, email, name, status, verification_token, expires_at, consent_text, ip, user_agent)
			VALUES (2, 'dup@example.com', 'New', 'pending', 'tok-new', '2099-01-01T00:00:00.000Z', 'x', '2.2.2.2', 'test');
		INSERT INTO contact_submissions (id, email, name, status, verification_token, expires_at, consent_text, ip, user_agent)
			VALUES (3, 'dup@example.com', 'Verified', 'verified', 'tok-verified', '2099-01-01T00:00:00.000Z', 'x', '3.3.3.3', 'test');
		INSERT INTO contact_submissions (id, email, name, status, verification_token, expires_at, consent_text, ip, user_agent)
			VALUES (4, 'other@example.com', 'Other', 'pending', 'tok-other', '2099-01-01T00:00:00.000Z', 'x', '4.4.4.4', 'test');
	`;
	const client = await applyMigration(preDdl, MIGRATION, seedSql);

	// The newest pending row per e-mail survives; the stale duplicate is gone.
	const pending = await client.execute(
		"SELECT id, email FROM contact_submissions WHERE status = 'pending' ORDER BY id"
	);
	expect(pending.rows.map((row) => ({ id: Number(row.id), email: String(row.email) }))).toEqual([
		{ id: 2, email: 'dup@example.com' },
		{ id: 4, email: 'other@example.com' }
	]);

	// The verified row is untouched by the pending-only dedupe.
	const verified = await client.execute(
		"SELECT id, email FROM contact_submissions WHERE status = 'verified'"
	);
	expect(verified.rows.map((row) => ({ id: Number(row.id), email: String(row.email) }))).toEqual([
		{ id: 3, email: 'dup@example.com' }
	]);

	// The partial unique index exists and now bites: a second pending row for
	// 'other@example.com' is rejected.
	const indexes = await client.execute("PRAGMA index_list('contact_submissions')");
	const names = indexes.rows.map((row) => String(row.name));
	expect(names).toContain('contact_submissions_pending_email_unique');
	await expect(
		client.execute(
			"INSERT INTO contact_submissions (email, name, status, verification_token, expires_at, consent_text, ip, user_agent) " +
				"VALUES ('other@example.com', 'B', 'pending', 'tok-dup', '2099-01-01T00:00:00.000Z', 'x', '5.5.5.5', 'test')"
		)
	).rejects.toThrow('UNIQUE');
});
