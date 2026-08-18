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

import { applyMigration, closeMigratedDbs, expectTenancyContract } from './migrationTestUtils';

// Behavior test for migration 0015: per-channel protection settings.
// channels gains protect_lgbtqia and protect_women — off-by-default (0)
// toggles, same convention as marketing_opt_in (integer NOT NULL DEFAULT 0).
// Expand-only per I7: existing rows must read 0 without any backfill, new
// inserts default to 0, explicit 1 is writable, and the tenancy contract is
// untouched.
const MIGRATION = '0015_channels_protect_flags.sql';

// The pre-0015 channels table: final 0014 shape (tenancy contract + history
// drain state, 15 columns).
const PRE_0015_DDL = `
	CREATE TABLE channels (
		id TEXT PRIMARY KEY,
		user_id TEXT,
		org_id TEXT,
		title TEXT NOT NULL,
		refresh_token_enc TEXT NOT NULL,
		cursor TEXT,
		next_page_token TEXT,
		scan_cursor TEXT,
		history_next_page_token TEXT,
		history_boundary TEXT,
		last_run_at TEXT,
		lease_expires_at TEXT,
		active INTEGER NOT NULL DEFAULT 1,
		tone_level INTEGER,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		CONSTRAINT channels_org_requires_owner CHECK(org_id IS NOT NULL OR user_id IS NULL)
	);
	CREATE INDEX channels_user_id_idx ON channels (user_id);
	CREATE INDEX channels_org_id_idx ON channels (org_id);
`;

const SEED = `
	INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc)
	VALUES ('UCexisting', 'user-1', 'org-1', 'Existing', 'enc-e');
`;

afterEach(closeMigratedDbs);

test('migration 0015 adds both protection flags and existing rows read 0', async () => {
	const client = await applyMigration(PRE_0015_DDL, MIGRATION, SEED);
	const cols = await client.execute('PRAGMA table_info(channels)');
	const names = cols.rows.map((row) => row.name);
	expect(names).toContain('protect_lgbtqia');
	expect(names).toContain('protect_women');
	expect(cols.rows).toHaveLength(17);
	for (const flag of ['protect_lgbtqia', 'protect_women']) {
		const col = cols.rows.find((row) => row.name === flag);
		expect(col?.notnull, `${flag} must be NOT NULL`).toBe(1);
		expect(col?.dflt_value, `${flag} must default 0`).toBe('0');
	}
	const { rows } = await client.execute('SELECT id, protect_lgbtqia, protect_women FROM channels');
	expect(rows).toEqual([{ id: 'UCexisting', protect_lgbtqia: 0, protect_women: 0 }]);
});

test('new inserts default both flags to 0 and accept explicit opt-in', async () => {
	const client = await applyMigration(PRE_0015_DDL, MIGRATION);
	await client.execute(
		"INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc) VALUES ('UCdefault', 'user-1', 'org-1', 'D', 'enc')"
	);
	await client.execute(
		"INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc, protect_lgbtqia, protect_women) VALUES ('UCon', 'user-1', 'org-1', 'On', 'enc', 1, 1)"
	);
	const { rows } = await client.execute('SELECT id, protect_lgbtqia, protect_women FROM channels ORDER BY id');
	expect(rows).toEqual([
		{ id: 'UCdefault', protect_lgbtqia: 0, protect_women: 0 },
		{ id: 'UCon', protect_lgbtqia: 1, protect_women: 1 }
	]);
});

test('the tenancy contract still bites after 0015', async () => {
	const client = await applyMigration(PRE_0015_DDL, MIGRATION, SEED);
	await expectTenancyContract(client);
});
