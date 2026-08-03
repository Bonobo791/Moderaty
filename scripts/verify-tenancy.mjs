#!/usr/bin/env node
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
//
// Tenancy Definition-of-Done probe: verifies the multi-tenancy invariants of
// whichever Turso database TURSO_DATABASE_URL points at (dev `db` by default;
// point it at production `moderaty` after applying a migration there). READ
// ONLY except the contract probes, which clean up after themselves.
//
// Usage:
//   node --env-file=.env scripts/verify-tenancy.mjs
//
// Exit code 0 = every invariant holds; 1 = at least one failed (each failure
// prints loudly with the offending rows).

import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
	console.error('verify-tenancy: TURSO_DATABASE_URL is not set (use --env-file=.env)');
	process.exit(1);
}

const client = createClient({ url, authToken });
let failures = 0;

function report(label, ok, detail) {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — ${detail}`}`);
	if (!ok) failures += 1;
}

const scalar = async (sql) => (await client.execute(sql)).rows[0].n;
const rows = async (sql) => (await client.execute(sql)).rows;

console.log(`verify-tenancy against ${url}`);

// 1. Structural integrity.
report('PRAGMA foreign_key_check returns zero rows', (await rows('PRAGMA foreign_key_check')).length === 0, JSON.stringify(await rows('PRAGMA foreign_key_check')));
const integrity = (await client.execute('PRAGMA integrity_check')).rows[0].integrity_check;
report('PRAGMA integrity_check is ok', integrity === 'ok', integrity);

// 2. Tenancy contract: the CHECK exists and bites.
const ddl = (await client.execute("SELECT sql FROM sqlite_master WHERE name = 'channels' AND type = 'table'")).rows[0]?.sql ?? '';
report('channels DDL contains channels_org_requires_owner', ddl.includes('channels_org_requires_owner'), ddl.slice(0, 200));
let rejected = false;
try {
	await client.execute("INSERT INTO channels (id, user_id, title, refresh_token_enc) VALUES ('UCverify-probe', 'probe', 't', 'x')");
} catch {
	rejected = true;
}
report('owned channel with NULL org is rejected', rejected, 'INSERT was allowed');
const orphans = await scalar("SELECT count(*) AS n FROM channels WHERE id = 'UCverify-probe'");
report('rejected probe left no row', orphans === 0, `${orphans} row(s) present`);

// 3. Data invariants.
report(
	'zero channels with user_id set and org_id NULL',
	(await scalar('SELECT count(*) AS n FROM channels WHERE user_id IS NOT NULL AND org_id IS NULL')) === 0,
	JSON.stringify(await rows('SELECT id FROM channels WHERE user_id IS NOT NULL AND org_id IS NULL'))
);
report(
	'every live user has exactly one personal org',
	(await scalar(`SELECT count(*) AS n FROM (SELECT u.id FROM users u LEFT JOIN organizations o ON o.personal_for = u.id WHERE u.google_sub NOT LIKE 'deleted:%' GROUP BY u.id HAVING count(o.id) != 1)`)) === 0,
	JSON.stringify(await rows(`SELECT u.id, count(o.id) AS orgs FROM users u LEFT JOIN organizations o ON o.personal_for = u.id WHERE u.google_sub NOT LIKE 'deleted:%' GROUP BY u.id HAVING orgs != 1`))
);
report(
	'every live user owns their personal org',
	(await scalar(`SELECT count(*) AS n FROM users u WHERE u.google_sub NOT LIKE 'deleted:%' AND NOT EXISTS (SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = u.id AND o.personal_for = u.id AND m.role = 'owner')`)) === 0,
	JSON.stringify(await rows(`SELECT u.id FROM users u WHERE u.google_sub NOT LIKE 'deleted:%' AND NOT EXISTS (SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = u.id AND o.personal_for = u.id AND m.role = 'owner')`))
);
report(
	'no ownerless orgs',
	(await scalar(`SELECT count(*) AS n FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.role = 'owner')`)) === 0,
	JSON.stringify(await rows(`SELECT o.id FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.role = 'owner')`))
);
report(
	'no memberless orgs',
	(await scalar('SELECT count(*) AS n FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id)')) === 0,
	JSON.stringify(await rows('SELECT o.id FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id)'))
);

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
client.close();
process.exit(failures === 0 ? 0 : 1);
