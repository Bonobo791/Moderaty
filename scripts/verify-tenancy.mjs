#!/usr/bin/env node
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
//
// Tenancy Definition-of-Done probe: verifies the multi-tenancy invariants of
// whichever Turso database TURSO_DATABASE_URL points at (dev `dev-2` by default;
// point it at production `moderaty` after applying a migration there). READ
// ONLY except the contract probes, which clean up after themselves.
//
// Usage:
//   node --env-file=.env scripts/verify-tenancy.mjs
//
// Exit code 0 = every invariant holds; 1 = at least one failed (each failure
// prints loudly with the offending rows).

import { randomUUID } from 'node:crypto';
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
	const suffix = ok ? '' : ` — ${detail}`;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${suffix}`);
	if (!ok) failures += 1;
}

const fail = (error) => `unexpected error: ${error instanceof Error ? error.message : String(error)}`;

const scalar = async (sql) => {
	const result = await client.execute(sql);
	if (!result.rows.length) throw new Error(`verify-tenancy: count query returned no rows: ${JSON.stringify(sql)}`);
	return result.rows[0].n;
};
const rows = async (sql) => (await client.execute(sql)).rows;

/** Zero-count invariant with per-check containment: a broken query is a loud FAIL, never an abort. */
async function expectZero(label, countSql, detailSql) {
	try {
		const n = await scalar(countSql);
		// Detail rows only exist to diagnose a violation — never scan them on a
		// healthy database, and bound the blob when one fires.
		if (n === 0) {
			report(label, true);
			return;
		}
		const sample = await rows(`SELECT * FROM (${detailSql}) LIMIT 50`);
		report(label, false, `${n} row(s), e.g. ${JSON.stringify(sample)}`);
	} catch (error) {
		report(label, false, fail(error));
	}
}

console.log(`verify-tenancy against ${url}`);

try {
	// 1. Structural integrity.
	try {
		const fk = await rows('PRAGMA foreign_key_check');
		report('PRAGMA foreign_key_check returns zero rows', fk.length === 0, JSON.stringify(fk));
	} catch (error) {
		report('PRAGMA foreign_key_check returns zero rows', false, fail(error));
	}
	try {
		const integrity = (await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check;
		report('PRAGMA integrity_check is ok', integrity === 'ok', String(integrity));
	} catch (error) {
		report('PRAGMA integrity_check is ok', false, fail(error));
	}

	// 2. Tenancy contract: the CHECK exists and bites.
	let ddl = '';
	try {
		ddl = (await client.execute("SELECT sql FROM sqlite_master WHERE name = 'channels' AND type = 'table'")).rows[0]?.sql ?? '';
	} catch (error) {
		report('channels DDL is readable', false, fail(error));
	}
	report('channels DDL contains channels_org_requires_owner', ddl.includes('channels_org_requires_owner'), ddl.slice(0, 200));
	const probeId = `UCverify-${randomUUID()}`;
	let rejected = false;
	let inserted = false;
	let probeDetail = 'INSERT was allowed';
	try {
		await client.execute({
			sql: 'INSERT INTO channels (id, user_id, title, refresh_token_enc) VALUES (?, ?, ?, ?)',
			args: [probeId, 'probe', 't', 'x']
		});
		inserted = true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Only the CONTRACT failing counts as a rejection — anything else
		// (missing table, a DIFFERENT constraint, connection drop) is a probe
		// failure and must read as FAIL, never as a false PASS.
		if (/channels_org_requires_owner/i.test(message)) {
			rejected = true;
		} else {
			probeDetail = `unexpected error (not the contract): ${message}`;
		}
	}
	report('owned channel with NULL org is rejected', rejected, probeDetail);
	// Cleanup touches only the row THIS invocation inserted, and only when the
	// INSERT actually succeeded — a fresh UUID per run can never match
	// pre-existing data.
	if (inserted) {
		try {
			await client.execute({ sql: 'DELETE FROM channels WHERE id = ?', args: [probeId] });
			const orphans = await scalar({ sql: 'SELECT count(*) AS n FROM channels WHERE id = ?', args: [probeId] });
			report('probe row is gone after cleanup', orphans === 0, `${orphans} row(s) present`);
		} catch (error) {
			report('probe row is gone after cleanup', false, fail(error));
		}
	}

	// 3. Data invariants.
	await expectZero(
		'zero channels with user_id set and org_id NULL',
		'SELECT count(*) AS n FROM channels WHERE user_id IS NOT NULL AND org_id IS NULL',
		'SELECT id FROM channels WHERE user_id IS NOT NULL AND org_id IS NULL'
	);
	await expectZero(
		'every live user has exactly one personal org',
		`SELECT count(*) AS n FROM (SELECT u.id FROM users u LEFT JOIN organizations o ON o.personal_for = u.id WHERE u.google_sub NOT LIKE 'deleted:%' GROUP BY u.id HAVING count(o.id) != 1)`,
		`SELECT u.id, count(o.id) AS orgs FROM users u LEFT JOIN organizations o ON o.personal_for = u.id WHERE u.google_sub NOT LIKE 'deleted:%' GROUP BY u.id HAVING orgs != 1`
	);
	await expectZero(
		'every live user owns their personal org',
		`SELECT count(*) AS n FROM users u WHERE u.google_sub NOT LIKE 'deleted:%' AND NOT EXISTS (SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = u.id AND o.personal_for = u.id AND m.role = 'owner')`,
		`SELECT u.id FROM users u WHERE u.google_sub NOT LIKE 'deleted:%' AND NOT EXISTS (SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = u.id AND o.personal_for = u.id AND m.role = 'owner')`
	);
	await expectZero(
		'no ownerless orgs',
		`SELECT count(*) AS n FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.role = 'owner')`,
		`SELECT o.id FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.role = 'owner')`
	);
	await expectZero(
		'no memberless orgs',
		'SELECT count(*) AS n FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id)',
		'SELECT o.id FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id)'
	);

	// 4. Cross-tenant invariants (tenancy audit — docs/tenancy-audit.md). A
	// session may only act in an org its user belongs to; every channel-scoped
	// row must resolve to a real channel; every channel must sit in an org
	// somebody can actually sign into. NULL active_org_id is legitimate
	// (resolved to the oldest membership at request time), as is a NULL org_id
	// on a pre-account orphan channel — both are excluded explicitly.
	await expectZero(
		'zero sessions acting in an org the user is not a member of',
		`SELECT count(*) AS n FROM sessions s WHERE s.active_org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = s.active_org_id AND m.user_id = s.user_id)`,
		`SELECT s.id, s.user_id, s.active_org_id FROM sessions s WHERE s.active_org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = s.active_org_id AND m.user_id = s.user_id)`
	);
	for (const table of ['comments', 'moderation_actions', 'audit_log', 'rules', 'channel_allowed_handles']) {
		await expectZero(
			`zero ${table} with channel_id missing from channels`,
			`SELECT count(*) AS n FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = t.channel_id)`,
			`SELECT t.channel_id FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = t.channel_id)`
		);
	}
	await expectZero(
		'zero channels in orgs with no memberships',
		'SELECT count(*) AS n FROM channels ch WHERE ch.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = ch.org_id)',
		'SELECT ch.id, ch.org_id FROM channels ch WHERE ch.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = ch.org_id)'
	);
} catch (error) {
	report('verify-tenancy completed without internal errors', false, fail(error));
} finally {
	client.close();
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
