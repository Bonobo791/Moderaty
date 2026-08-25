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

import fc from 'fast-check';
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';

import { DAY_MS, setupTestDb, testDb, wipeTables } from './testdb';
import { memberships, organizations, sessions, users } from './db/schema';
import { createSession, getSessionUser, RENEW_BELOW_MS, SESSION_TTL_MS } from './session';
// Side-effect import: configures fast-check numRuns globally (FC_NUM_RUNS).
import './testarbitraries';

const WIPE = ['sessions', 'memberships', 'organizations', 'users'];

setupTestDb(WIPE);

// Imported from the source (not re-derived as SESSION_TTL_MS / 2) so the
// renewal boundary cannot drift from the production threshold (deferral #3).
// Guard band around the zone edges: the milliseconds that pass between row
// insert and resolution can never flip a run into a neighboring zone. The
// exact boundaries (expiresAt == now, remaining == 15d) are pinned by the
// example tests in session.test.ts.
const GUARD_MS = 60_000;

/** Seeds the user + personal org + owner membership graph getSessionUser resolves (mirrors session.test.ts). */
async function seedUserWithOrg(id: string): Promise<string> {
	await testDb().db.insert(users).values({ id, googleSub: `sub-${id}`, email: `${id}@example.com`, displayName: id });
	// Every surviving user has a personal org + owner membership (Phase A backfill shape).
	await testDb().db.insert(organizations).values({ id: `org-${id}`, name: id, personalFor: id });
	await testDb().db.insert(memberships).values({ userId: id, orgId: `org-${id}`, role: 'owner' });
	return id;
}

test('token uniqueness/format: N sessions yield N pairwise-distinct 64-hex tokens', async () => {
	// Property audit: a counter/timestamp-based token source eventually collides
	// or breaks the hex shape across runs; a truncated randomBytes breaks the
	// 64-char format assertion.
	await fc.assert(
		fc.asyncProperty(fc.integer({ min: 2, max: 25 }), async (count) => {
			await wipeTables(WIPE); // fresh state per run, not per test
			const userId = await seedUserWithOrg('user-1');
			const tokens: string[] = [];
			for (let i = 0; i < count; i++) {
				const { token } = await createSession(userId);
				tokens.push(token);
			}
			for (const token of tokens) {
				expect(token).toMatch(/^[0-9a-f]{64}$/);
			}
			expect(new Set(tokens).size).toBe(count);
		})
	);
});

type Zone = 'expired' | 'renewal' | 'live';

/**
 * Remaining session life as generated data (never the clock): expired (≤0),
 * renewal zone (0 < remaining < 15d), no-renewal zone (≥15d, ≤30d + slack) —
 * guard-banded by construction so all three zones are covered in one property.
 */
const remainingLifeArb: fc.Arbitrary<{ zone: Zone; offsetMs: number }> = fc.oneof(
	fc
		.integer({ min: -SESSION_TTL_MS, max: -GUARD_MS })
		.map((offsetMs) => ({ zone: 'expired' as const, offsetMs })),
	fc
		.integer({ min: GUARD_MS, max: RENEW_BELOW_MS - GUARD_MS })
		.map((offsetMs) => ({ zone: 'renewal' as const, offsetMs })),
	fc
		.integer({ min: RENEW_BELOW_MS + GUARD_MS, max: SESSION_TTL_MS + DAY_MS })
		.map((offsetMs) => ({ zone: 'live' as const, offsetMs }))
);

test('sliding-cap dichotomy: expired rows are lazily deleted, <15d renew in place to ~now+30d, >=15d stay untouched', async () => {
	// Property audit: dropping the lazy delete leaves the expired row behind;
	// a `<` → `<=` flip on the renewal guard mis-classifies live-zone runs;
	// renewing to a fixed date or not updating the row breaks the ~now+30d
	// assertion in the renewal zone.
	await fc.assert(
		fc.asyncProperty(remainingLifeArb, async ({ zone, offsetMs }) => {
			await wipeTables(WIPE);
			const userId = await seedUserWithOrg('user-1');
			const now = Date.now();
			const expiresAt = new Date(now + offsetMs).toISOString();
			// A session with this remaining life was created 30d before its expiry
			// (clamped to now for the >30d slack); createdAt is storage-consistent
			// but never read by getSessionUser.
			const createdAt = new Date(Math.min(now + offsetMs - SESSION_TTL_MS, now)).toISOString();
			await testDb().db.insert(sessions).values({ id: 'token-under-test', userId, expiresAt, createdAt });

			const result = await getSessionUser('token-under-test');
			const row = await testDb()
				.db.select()
				.from(sessions)
				.where(eq(sessions.id, 'token-under-test'))
				.get();

			if (zone === 'expired') {
				expect(result).toBeNull();
				expect(row).toBeUndefined(); // lazy delete
			} else if (zone === 'renewal') {
				expect(result).not.toBeNull();
				expect(result?.user.id).toBe(userId);
				expect(result?.renewed).toBe(true);
				expect(row).toBeDefined();
				const renewedMs = Date.parse(row!.expiresAt);
				const assertionNow = Date.now();
				expect(renewedMs).toBeGreaterThanOrEqual(assertionNow + SESSION_TTL_MS - 5000);
				expect(renewedMs).toBeLessThanOrEqual(assertionNow + SESSION_TTL_MS + 5000);
			} else {
				expect(result).not.toBeNull();
				expect(result?.user.id).toBe(userId);
				expect(result?.renewed).toBe(false);
				expect(row?.expiresAt).toBe(expiresAt); // untouched
			}
		})
	);
});
