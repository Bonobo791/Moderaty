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

import { expect, test } from 'vitest';

import { setupTestDb, testDb, TEST_OWNER } from './testdb';
import { channels } from './db/schema';
import { ownedChannel, requireOrgRole } from './ownership';
import type { SessionUser } from './session';

setupTestDb(['channels', 'users']);

const OWNER = TEST_OWNER;

test('requireOrgRole throws 403 for an unknown role — fail closed, never fail open', () => {
	// Unreachable today (asOrgRole throws on unknown roles before a SessionUser
	// can be built), but the comparison itself must fail closed if a bogus
	// role ever gets through: undefined < N is false, which would ALLOW.
	const bogus = { ...OWNER, orgRole: 'bogus' } as unknown as SessionUser;

	expect(() => requireOrgRole(bogus, 'admin')).toThrowError(expect.objectContaining({ status: 403 }));
});

test('requireOrgRole throws 403 for a member below the admin minimum', () => {
	const member: SessionUser = { ...OWNER, orgRole: 'member' };

	expect(() => requireOrgRole(member, 'admin')).toThrowError(expect.objectContaining({ status: 403 }));
	expect(() => requireOrgRole(member, 'owner')).toThrowError(expect.objectContaining({ status: 403 }));
});

test('requireOrgRole passes for admin and owner at the admin minimum', () => {
	expect(() => requireOrgRole({ ...OWNER, orgRole: 'admin' }, 'admin')).not.toThrow();
	expect(() => requireOrgRole(OWNER, 'admin')).not.toThrow();
});

test('requireOrgRole passes only for owner at the owner minimum', () => {
	expect(() => requireOrgRole({ ...OWNER, orgRole: 'admin' }, 'owner')).toThrowError(
		expect.objectContaining({ status: 403 })
	);
	expect(() => requireOrgRole(OWNER, 'owner')).not.toThrow();
});

test('ownedChannel returns the channel for the user\'s org', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'Ch', refreshTokenEnc: 'enc' });

	const ch = await ownedChannel('UC1', { user: OWNER });

	expect(ch).toMatchObject({ id: 'UC1', orgId: 'org-1', title: 'Ch' });
});

test('ownedChannel returns a same-org channel connected by a teammate', async () => {
	// Tenancy is per-ORG: who connected the channel no longer gates access.
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: 'user-2', orgId: 'org-1', title: 'Ch', refreshTokenEnc: 'enc' });

	const ch = await ownedChannel('UC1', { user: OWNER });

	expect(ch).toMatchObject({ id: 'UC1', userId: 'user-2', orgId: 'org-1' });
});

test('ownedChannel throws 404 for another org\'s channel without leaking existence', async () => {
	// The caller personally connected this channel — under another org. The
	// org gate, not the connector, decides (a per-user check would pass here).
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, orgId: 'org-2', title: 'Ch', refreshTokenEnc: 'enc' });

	await expect(ownedChannel('UC1', { user: OWNER })).rejects.toMatchObject({
		status: 404,
		body: { message: 'channel not found' }
	});
});

test('ownedChannel 404 message is non-empty for a missing channel id', async () => {
	await expect(ownedChannel('UC-missing', { user: OWNER })).rejects.toMatchObject({
		status: 404,
		body: { message: 'channel not found' }
	});
});

test('ownedChannel throws 401 when signed out', async () => {
	await expect(ownedChannel('UC1', { user: null })).rejects.toMatchObject({ status: 401 });
});
