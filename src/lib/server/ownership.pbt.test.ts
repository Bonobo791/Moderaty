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

import fc from 'fast-check';
import { expect, test } from 'vitest';

import { setupTestDb, testDb, wipeTables } from './testdb';
import { channels, users } from './db/schema';
import { ownedChannel } from './ownership';
import type { SessionUser } from './session';
import {
	MEMBERSHIP_ROLES,
	channelRowArb,
	idArb,
	isoTimestampArb,
	orgRowArb,
	userRowArb,
	type ChannelRow,
	type OrgRow,
	type UserRow
} from './testarbitraries';

const WIPE = ['channels', 'users'];

setupTestDb(WIPE);

type OrgRole = (typeof MEMBERSHIP_ROLES)[number];

interface Tenant {
	user: UserRow;
	org: OrgRow;
	role: OrgRole;
}

/** Channel column sweep beyond channelRowArb: active/tone/protect flags and cursor/lease states. */
const channelExtrasArb = fc.record({
	active: fc.constantFrom(0, 1),
	toneLevel: fc.option(fc.integer({ min: 1, max: 2 }), { nil: null }),
	cursor: fc.option(isoTimestampArb, { nil: null }),
	nextPageToken: fc.option(idArb, { nil: null }),
	scanCursor: fc.option(isoTimestampArb, { nil: null }),
	leaseExpiresAt: fc.option(isoTimestampArb, { nil: null }),
	protectLgbtqia: fc.constantFrom(0, 1),
	protectWomen: fc.constantFrom(0, 1)
});

/**
 * Two tenants with DISTINCT user/org ids by construction: the 'z' prefix sits
 * outside idArb's hex alphabet (and stretches the id), so a derived id never
 * collides with a generated one — no .filter needed.
 */
const twoTenantsArb: fc.Arbitrary<{ a: Tenant; b: Tenant }> = fc
	.record({
		userA: userRowArb,
		orgA: orgRowArb,
		userB: userRowArb,
		orgB: orgRowArb,
		roleA: fc.constantFrom(...MEMBERSHIP_ROLES),
		roleB: fc.constantFrom(...MEMBERSHIP_ROLES)
	})
	.map((generated) => ({
		a: { user: generated.userA, org: generated.orgA, role: generated.roleA },
		b: {
			user: { ...generated.userB, id: `z${generated.userB.id}` },
			org: { ...generated.orgB, id: `z${generated.orgB.id}` },
			role: generated.roleB
		}
	}));

type ChannelInsert = ChannelRow & {
	active: number;
	toneLevel: number | null;
	cursor: string | null;
	nextPageToken: string | null;
	scanCursor: string | null;
	leaseExpiresAt: string | null;
	protectLgbtqia: number;
	protectWomen: number;
};

/** A channel owned by the tenant's org (connected by the tenant's user), sweeping shape state. */
function channelInOrgArb(tenant: Tenant): fc.Arbitrary<ChannelInsert> {
	return fc.tuple(channelRowArb, channelExtrasArb).map(([base, extras]) => ({
		...base,
		userId: tenant.user.id,
		orgId: tenant.org.id,
		...extras
	}));
}

/** Flips the trailing character so a colliding generated id becomes distinct (deterministic, no .filter). */
function flipLastChar(id: string): string {
	const last = id[id.length - 1];
	return `${id.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
}

const runArb = twoTenantsArb.chain(({ a, b }) =>
	fc.tuple(channelInOrgArb(a), channelInOrgArb(b)).map(([channelA, channelB]) => ({
		a,
		b,
		channelA,
		channelB: { ...channelB, id: channelB.id === channelA.id ? flipLastChar(channelB.id) : channelB.id }
	}))
);

/** Mirrors ownership.test.ts's SessionUser shape (the tenancy context is the ACTIVE org). */
function sessionOf(tenant: Tenant): SessionUser {
	return {
		id: tenant.user.id,
		email: tenant.user.email,
		displayName: tenant.user.displayName,
		plan: 'free',
		orgId: tenant.org.id,
		orgName: tenant.org.name,
		orgRole: tenant.role
	};
}

test('404-never-403: another tenant\'s channel reads as not-found across generated tenants and channel shapes', async () => {
	// Property audit: dropping the orgId conjunct in ownedChannel's WHERE (or
	// scoping by userId instead of orgId) hands tenant B tenant A's row — the
	// rejects assertion goes red. Throwing 403 instead of 404 (leaking
	// existence) breaks the status-404 assertion. Returning the row instead of
	// throwing resolves the promise — red again. A missing requireUser 401
	// check drops the signed-out leg to a 404 — red.
	await fc.assert(
		fc.asyncProperty(runArb, async ({ a, b, channelA, channelB }) => {
			await wipeTables(WIPE); // fresh state per run, not per test
			for (const tenant of [a, b]) {
				await testDb().db.insert(users).values({
					id: tenant.user.id,
					googleSub: tenant.user.googleSub,
					email: tenant.user.email,
					displayName: tenant.user.displayName
				});
			}
			await testDb().db.insert(channels).values([channelA, channelB]);

			// Foreign tenant in BOTH directions: 404 with the exact non-leaking
			// message — never 403, and the promise must reject (never the row).
			await expect(ownedChannel(channelA.id, { user: sessionOf(b) })).rejects.toMatchObject({
				status: 404,
				body: { message: 'channel not found' }
			});
			await expect(ownedChannel(channelB.id, { user: sessionOf(a) })).rejects.toMatchObject({
				status: 404,
				body: { message: 'channel not found' }
			});
			// Sanity leg: same-org access returns the channel row.
			const own = await ownedChannel(channelA.id, { user: sessionOf(a) });
			expect(own).toMatchObject({ id: channelA.id, orgId: a.org.id });
			// Signed out: 401 before any tenancy check.
			await expect(ownedChannel(channelA.id, { user: null })).rejects.toMatchObject({ status: 401 });
		})
	);
});
