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

// Behavior tests for verify-tenancy.mjs: against a CONTRACT database it exits
// 0 with every check passing; against a database missing the tenancy contract
// or violating an invariant it must exit 1 and name the failing check (a
// probe that always passes is worse than no probe).

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PROBE = new URL('./verify-tenancy.mjs', import.meta.url);

const tmp = mkdtempSync(join(tmpdir(), 'verify-tenancy-test-'));
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const BASE_DDL = `
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	google_sub TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL,
	display_name TEXT NOT NULL,
	plan TEXT NOT NULL DEFAULT 'free',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE organizations (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	plan TEXT NOT NULL DEFAULT 'free',
	personal_for TEXT UNIQUE,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE memberships (
	user_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	role TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (user_id, org_id)
);
CREATE TABLE channels (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	org_id TEXT,
	title TEXT NOT NULL,
	refresh_token_enc TEXT NOT NULL,
	cursor TEXT,
	next_page_token TEXT,
	scan_cursor TEXT,
	last_run_at TEXT,
	lease_expires_at TEXT,
	active INTEGER NOT NULL DEFAULT 1,
	tone_level INTEGER,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	<CONTRACT>
);
`;

// One live user with a personal org, an owner membership, and an orged channel.
const SEED = `
INSERT INTO users (id, google_sub, email, display_name) VALUES ('u1', 'sub-1', 'u1@example.com', 'U1');
INSERT INTO organizations (id, name, personal_for) VALUES ('org-u1', 'U1', 'u1');
INSERT INTO memberships (user_id, org_id, role) VALUES ('u1', 'org-u1', 'owner');
INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc) VALUES ('UC1', 'u1', 'org-u1', 'Chan', 'enc');
`;

/** Builds a temp database; withContract toggles the CHECK constraint (the pre-0013 shape). */
async function buildDb(name, { withContract, seedSql = '' }) {
	const url = `file:${join(tmp, name)}`;
	const client = createClient({ url });
	const ddl = BASE_DDL.replace('<CONTRACT>', withContract ? ',\n\tCONSTRAINT channels_org_requires_owner CHECK (org_id IS NOT NULL OR user_id IS NULL)' : '');
	for (const statement of (ddl + seedSql).split(';')) {
		const trimmed = statement.trim();
		if (trimmed) await client.execute(trimmed);
	}
	client.close();
	return url;
}

/** Runs the probe against `url` with no auth token (file: URL); returns exit code + stdout. */
async function runProbe(url) {
	const { TURSO_AUTH_TOKEN: _token, TURSO_DATABASE_URL: _url, ...rest } = process.env;
	try {
		const { stdout } = await execFileAsync('node', [PROBE.pathname], { env: { ...rest, TURSO_DATABASE_URL: url } });
		return { code: 0, stdout };
	} catch (error) {
		return { code: error.code, stdout: error.stdout ?? '' };
	}
}

describe('verify-tenancy', () => {
	it('passes every check against a contract database with healthy tenancy', async () => {
		const url = await buildDb('contract.db', { withContract: true, seedSql: SEED });
		const { code, stdout } = await runProbe(url);
		expect(stdout).not.toContain('FAIL');
		expect(stdout).toContain('ALL CHECKS PASSED');
		expect(code).toBe(0);
	}, 20000);

	it('fails loudly on a pre-contract database (no CHECK, violating INSERT allowed)', async () => {
		const url = await buildDb('pre-contract.db', { withContract: false, seedSql: SEED });
		const { code, stdout } = await runProbe(url);
		expect(code).toBe(1);
		expect(stdout).toContain('FAIL  channels DDL contains channels_org_requires_owner');
		expect(stdout).toContain('FAIL  owned channel with NULL org is rejected');
	}, 20000);

	it('fails loudly when an org has no owner', async () => {
		const url = await buildDb('ownerless.db', {
			withContract: true,
			seedSql:
				SEED +
				"INSERT INTO organizations (id, name) VALUES ('ghost', 'Ghost');" +
				"INSERT INTO memberships (user_id, org_id, role) VALUES ('u1', 'ghost', 'member');"
		});
		const { code, stdout } = await runProbe(url);
		expect(code).toBe(1);
		expect(stdout).toContain('FAIL  no ownerless orgs');
	}, 20000);
});
