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

import { error } from '@sveltejs/kit';
import { building } from '$app/environment';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import journal from '../../../drizzle/meta/_journal.json';

// Deploy-ordering guard (issue #81). Per DEPLOY.md §1, code merges first and
// the human applies the migration after — so every deploy has a window where
// the running code's schema is ahead of the database. In that window any
// full-row read of a migrated table dies with a scattered, per-query
// "no such column" error (the 0014 cron incident). This guard turns the
// window into ONE loud, actionable 503 at the request boundary instead.
//
// The expected count comes from the migration journal bundled at build time,
// so it always matches the deployed code's schema. A database AHEAD of the
// code is safe (expand-migrate-contract: new columns are nullable until the
// code that reads them ships), so only "behind" fails.

const expected = (journal as { entries: unknown[] }).entries.length;

// Cached on success only: a warm instance never re-checks, but an instance
// that saw the gap re-checks on every request and recovers the moment the
// human applies the migration — no redeploy needed. The in-flight check is
// memoized as a promise so a cold-start request burst collapses into one
// query; the cache is cleared on ANY rejection (503 or raw database error)
// so the next request retries instead of pinning to a stale failure.
let verificationPromise: Promise<void> | null = null;

/**
 * Fails the request loudly (503) when the database is behind the deployed
 * code's migration journal. Detail goes to the server log; the client gets a
 * generic retry message (never leak operational internals to the browser).
 *
 * @throws {HttpError} 503 when migrations are pending; raw database errors propagate
 */
export async function assertMigrationsCurrent(): Promise<void> {
	// Prerendered pages also run handle, and the build has no database —
	// the guard is a runtime deploy-ordering concern, not a build-time one.
	if (building) return;
	verificationPromise ??= checkMigrations().catch((e: unknown) => {
		verificationPromise = null;
		throw e;
	});
	return verificationPromise;
}

async function checkMigrations(): Promise<void> {
	const row = await db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM __drizzle_migrations`);
	const applied = row?.n ?? 0;
	if (applied < expected) {
		console.error(
			`database schema is behind the deployed code: ${applied}/${expected} migrations applied — run npm run db:migrate (DEPLOY.md §1)`
		);
		throw error(503, 'the service is being upgraded — please retry in a few minutes');
	}
}
