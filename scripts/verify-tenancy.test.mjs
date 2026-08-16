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
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PROBE = fileURLToPath(new URL('./verify-tenancy.mjs', import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), 'verify-tenancy-test-'));
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const NON_CHANNEL_DDL = `
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
CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	active_org_id TEXT,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE comments (
	id TEXT PRIMARY KEY,
	channel_id TEXT NOT NULL,
	text TEXT NOT NULL,
	published_at TEXT NOT NULL,
	status TEXT NOT NULL,
	decided_by TEXT NOT NULL
);
CREATE TABLE moderation_actions (
	comment_id TEXT PRIMARY KEY,
	channel_id TEXT NOT NULL,
	action TEXT NOT NULL,
	reason TEXT NOT NULL,
	state TEXT NOT NULL
);
CREATE TABLE audit_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	channel_id TEXT NOT NULL,
	comment_id TEXT NOT NULL,
	action TEXT NOT NULL,
	reason TEXT NOT NULL,
	actor TEXT NOT NULL
);
CREATE TABLE rules (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	channel_id TEXT NOT NULL,
	type TEXT NOT NULL,
	pattern TEXT NOT NULL,
	action TEXT NOT NULL
);
CREATE TABLE channel_allowed_handles (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	channel_id TEXT NOT NULL,
	handle TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

const CHANNELS_DDL = `
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

// One live user with a personal org and an owner membership.
const SEED_TENANCY = `
INSERT INTO users (id, google_sub, email, display_name) VALUES ('u1', 'sub-1', 'u1@example.com', 'U1');
INSERT INTO organizations (id, name, personal_for) VALUES ('org-u1', 'U1', 'u1');
INSERT INTO memberships (user_id, org_id, role) VALUES ('u1', 'org-u1', 'owner');
`;

const SEED_CHANNEL = `
INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc) VALUES ('UC1', 'u1', 'org-u1', 'Chan', 'enc');
`;

/** Builds a temp database; withContract toggles the CHECK constraint (the pre-0013 shape). */
async function buildDb(name, { withContract, withChannels = true, seedSql = '', extraConstraint = '' }) {
	const url = `file:${join(tmp, name)}`;
	const client = createClient({ url });
	const channelsDdl = withChannels
		? CHANNELS_DDL.replace(
				'<CONTRACT>',
				(withContract
					? ',\n\tCONSTRAINT channels_org_requires_owner CHECK (org_id IS NOT NULL OR user_id IS NULL)'
					: '') + extraConstraint
			)
		: '';
	for (const statement of (NON_CHANNEL_DDL + channelsDdl + seedSql).split(';')) {
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
		const { stdout } = await execFileAsync('node', [PROBE], { env: { ...rest, TURSO_DATABASE_URL: url } });
		return { code: 0, stdout };
	} catch (error) {
		return { code: error.code ?? 1, stdout: error.stdout ?? '' };
	}
}

describe('verify-tenancy', () => {
	it('passes every check against a contract database with healthy tenancy', async () => {
		const url = await buildDb('contract.db', { withContract: true, seedSql: SEED_TENANCY + SEED_CHANNEL });
		const { code, stdout } = await runProbe(url);
		expect(stdout).not.toContain('FAIL');
		expect(stdout).toContain('ALL CHECKS PASSED');
		expect(code).toBe(0);
	}, 20000);

	it('fails loudly on a pre-contract database (no CHECK, violating INSERT allowed but cleaned up)', async () => {
		const url = await buildDb('pre-contract.db', { withContract: false, seedSql: SEED_TENANCY + SEED_CHANNEL });
		const { code, stdout } = await runProbe(url);
		expect(code).toBe(1);
		expect(stdout).toContain('FAIL  channels DDL contains channels_org_requires_owner');
		expect(stdout).toContain('FAIL  owned channel with NULL org is rejected');
		// The probe INSERT succeeds here — it must be deleted, not left behind.
		expect(stdout).toContain('PASS  probe row is gone after cleanup');
		const client = createClient({ url });
		const leftover = await client.execute("SELECT count(*) AS n FROM channels WHERE id LIKE 'UCverify-%'");
		client.close();
		expect(leftover.rows[0].n).toBe(0);
	}, 20000);

	it('never false-passes when the probe fails for a non-contract reason (no channels table)', async () => {
		// A bare catch would report the missing-table error as "rejected" (a
		// PASS). The probe must read as FAIL with the actual error instead, and
		// the run must still reach its final summary instead of crashing.
		const url = await buildDb('no-channels.db', { withContract: true, withChannels: false, seedSql: SEED_TENANCY });
		const { code, stdout } = await runProbe(url);
		expect(code).toBe(1);
		expect(stdout).toContain('FAIL  owned channel with NULL org is rejected');
		expect(stdout).toContain('unexpected error');
		expect(stdout).toContain('CHECK(S) FAILED');
	}, 20000);

	it('never deletes a pre-existing row that happens to use the legacy probe id', async () => {
		// The probe must clean up only the row THIS invocation inserted; a row
		// that predates the run is data, not probe debris.
		const url = await buildDb('legacy-probe-row.db', {
			withContract: false,
			seedSql:
				SEED_TENANCY +
				SEED_CHANNEL +
				"INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc) VALUES ('UCverify-probe', NULL, 'org-u1', 'Legacy', 'enc');"
		});
		const { code, stdout } = await runProbe(url);
		expect(code).toBe(1); // pre-contract database still fails the contract checks
		// The probe INSERT itself must succeed (proving the contract really is
		// absent), which requires an ID that cannot collide with existing data.
		expect(stdout).toContain('INSERT was allowed');
		const client = createClient({ url });
		const legacy = await client.execute("SELECT count(*) AS n FROM channels WHERE id = 'UCverify-probe'");
		client.close();
		expect(legacy.rows[0].n).toBe(1);
	}, 20000);

	it('probe result does not depend on pre-existing rows (contract DB with legacy probe id)', async () => {
		// Even if a row literally named 'UCverify-probe' exists, the probe must
		// still prove the contract (PASS) and leave that row untouched.
		const url = await buildDb('contract-legacy-probe-row.db', {
			withContract: true,
			seedSql:
				SEED_TENANCY +
				SEED_CHANNEL +
				"INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc) VALUES ('UCverify-probe', NULL, 'org-u1', 'Legacy', 'enc');"
		});
		const { code, stdout } = await runProbe(url);
		expect(code).toBe(0);
		expect(stdout).toContain('PASS  owned channel with NULL org is rejected');
		const client = createClient({ url });
		const legacy = await client.execute("SELECT count(*) AS n FROM channels WHERE id = 'UCverify-probe'");
		client.close();
		expect(legacy.rows[0].n).toBe(1);
	}, 20000);

	it('never counts a different CHECK constraint as the tenancy contract', async () => {
		// channels_title_len rejects the probe INSERT (title 't' is too short);
		// that is NOT proof that channels_org_requires_owner bites.
		const url = await buildDb('other-check.db', {
			withContract: false,
			extraConstraint: ',\n\tCONSTRAINT channels_title_len CHECK (length(title) > 1)',
			seedSql: SEED_TENANCY + SEED_CHANNEL
		});
		const { code, stdout } = await runProbe(url);
		expect(code).toBe(1);
		expect(stdout).toContain('FAIL  owned channel with NULL org is rejected');
		expect(stdout).toContain('unexpected error');
	}, 20000);

	it('fails loudly when an org has no owner', async () => {
		const url = await buildDb('ownerless.db', {
			withContract: true,
			seedSql:
				SEED_TENANCY +
				SEED_CHANNEL +
				"INSERT INTO organizations (id, name) VALUES ('ghost', 'Ghost');" +
				"INSERT INTO memberships (user_id, org_id, role) VALUES ('u1', 'ghost', 'member');"
		});
		const { code, stdout } = await runProbe(url);
		expect(code).toBe(1);
		expect(stdout).toContain('FAIL  no ownerless orgs');
	}, 20000);

	it('passes the cross-tenant checks on healthy sessions and channel-scoped rows', async () => {
		const url = await buildDb('cross-tenant-healthy.db', {
			withContract: true,
			seedSql:
				SEED_TENANCY +
				SEED_CHANNEL +
				"INSERT INTO sessions (id, user_id, active_org_id, expires_at) VALUES ('s1', 'u1', 'org-u1', '2099-01-01T00:00:00Z');" +
				"INSERT INTO sessions (id, user_id, active_org_id, expires_at) VALUES ('s2', 'u1', NULL, '2099-01-01T00:00:00Z');" +
				"INSERT INTO comments (id, channel_id, text, published_at, status, decided_by) VALUES ('c1', 'UC1', 'hi', '2026-01-01T00:00:00Z', 'approved', 'ai');" +
				"INSERT INTO moderation_actions (comment_id, channel_id, action, reason, state) VALUES ('c1', 'UC1', 'hold', 'r', 'completed');" +
				"INSERT INTO audit_log (channel_id, comment_id, action, reason, actor) VALUES ('UC1', 'c1', 'approve', 'r', 'user');" +
				"INSERT INTO rules (channel_id, type, pattern, action) VALUES ('UC1', 'keyword', 'spam', 'hold');" +
				"INSERT INTO channel_allowed_handles (channel_id, handle) VALUES ('UC1', '@friend');"
		});
		const { code, stdout } = await runProbe(url);
		expect(stdout).not.toContain('FAIL');
		expect(stdout).toContain('ALL CHECKS PASSED');
		expect(code).toBe(0);
	}, 20000);

	it('fails loudly when a session acts in an org the user is not a member of', async () => {
		const url = await buildDb('session-cross-tenant.db', {
			withContract: true,
			seedSql:
				SEED_TENANCY +
				SEED_CHANNEL +
				"INSERT INTO organizations (id, name) VALUES ('other', 'Other');" +
				"INSERT INTO memberships (user_id, org_id, role) VALUES ('u1', 'other', 'owner');" +
				"INSERT INTO sessions (id, user_id, active_org_id, expires_at) VALUES ('s1', 'u1', 'other', '2099-01-01T00:00:00Z');" +
				// u1 leaves 'other' but the session keeps pointing at it.
				"DELETE FROM memberships WHERE user_id = 'u1' AND org_id = 'other';"
		});
		const { code, stdout } = await runProbe(url);
		expect(code).toBe(1);
		expect(stdout).toContain('FAIL  zero sessions acting in an org the user is not a member of');
	}, 20000);

	it('fails loudly when channel-scoped rows are orphaned from their channel', async () => {
		const url = await buildDb('orphaned-rows.db', {
			withContract: true,
			seedSql:
				SEED_TENANCY +
				SEED_CHANNEL +
				"INSERT INTO comments (id, channel_id, text, published_at, status, decided_by) VALUES ('c1', 'UCgone', 'hi', '2026-01-01T00:00:00Z', 'approved', 'ai');" +
				"INSERT INTO moderation_actions (comment_id, channel_id, action, reason, state) VALUES ('c1', 'UCgone', 'hold', 'r', 'completed');" +
				"INSERT INTO audit_log (channel_id, comment_id, action, reason, actor) VALUES ('UCgone', 'c1', 'approve', 'r', 'user');" +
				"INSERT INTO rules (channel_id, type, pattern, action) VALUES ('UCgone', 'keyword', 'spam', 'hold');" +
				"INSERT INTO channel_allowed_handles (channel_id, handle) VALUES ('UCgone', '@friend');"
		});
		const { code, stdout } = await runProbe(url);
		expect(code).toBe(1);
		expect(stdout).toContain('FAIL  zero comments with channel_id missing from channels');
		expect(stdout).toContain('FAIL  zero moderation_actions with channel_id missing from channels');
		expect(stdout).toContain('FAIL  zero audit_log with channel_id missing from channels');
		expect(stdout).toContain('FAIL  zero rules with channel_id missing from channels');
		expect(stdout).toContain('FAIL  zero channel_allowed_handles with channel_id missing from channels');
	}, 20000);

	it('fails loudly when a channel sits in an org with no memberships', async () => {
		const url = await buildDb('channel-memberless-org.db', {
			withContract: true,
			seedSql:
				SEED_TENANCY +
				"INSERT INTO organizations (id, name) VALUES ('empty-org', 'Empty');" +
				"INSERT INTO channels (id, user_id, org_id, title, refresh_token_enc) VALUES ('UC2', NULL, 'empty-org', 'Chan2', 'enc');"
		});
		const { code, stdout } = await runProbe(url);
		expect(code).toBe(1);
		expect(stdout).toContain('FAIL  zero channels in orgs with no memberships');
	}, 20000);
});
