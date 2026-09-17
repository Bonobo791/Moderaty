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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md
//
// Database connectivity preflight for the deploy gate (netlify-migrate.mjs).
// drizzle-kit migrate fails SILENTLY on connection errors — the spinner runs,
// then the process exits 1 with nothing on stderr. The 2026-09-17 Coolify dev
// deploy proved it: an expired TURSO_AUTH_TOKEN made Turso answer HTTP 401,
// and the deploy log contained only spinner frames. This script makes the same
// connection drizzle-kit is about to make (a bare SELECT 1 through
// @libsql/client, the same driver) and prints the REAL error, so a dead
// credential or unreachable host is diagnosable from the deploy log alone.
// Env-var presence is already preflighted by netlify-migrate.mjs before this
// runs; this step only proves the credentials actually work.

import { createClient } from '@libsql/client';

const databaseUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

try {
	const client = createClient({
		url: databaseUrl,
		authToken: authToken || undefined
	});
	await client.execute('SELECT 1');
	client.close();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(
		`db-preflight: cannot reach the database — ${message}\n` +
			'  This check exists because drizzle-kit exits 1 with no output on connection failures.\n' +
			'  Likely causes:\n' +
			'  - HTTP 401: TURSO_AUTH_TOKEN is expired, revoked, or minted for a different database.\n' +
			'    Mint a fresh non-expiring token (`turso db tokens create <db> -e never`) and update\n' +
			'    EVERY copy: the worktree .env, the Coolify app env (Build Variable flag ON — the\n' +
			'    Dockerfile only receives it via --mount=type=secret), and the Netlify branch-deploys\n' +
			'    context.\n' +
			'  - DNS/fetch errors: TURSO_DATABASE_URL is wrong, or Turso is unreachable from the\n' +
			'    builder.\n' +
			'  - file: URLs: the path is not writable by the build user.\n' +
			'blocking the deploy — a build that cannot reach its database must never ship.'
	);
	process.exit(1);
}

console.log('db-preflight: database reachable, credentials accepted.');
