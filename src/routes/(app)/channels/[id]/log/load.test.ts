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
import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels } from '$lib/server/db/schema';

import { load } from './+page.server';

setupTestDb(['audit_log', 'channels']);

const OWNER = TEST_OWNER;

async function seedChannel() {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'Ch', refreshTokenEnc: 'enc-secret' });
}

async function seedEntries(rows: { commentId: string; action: string; createdAt: string }[]) {
	await testDb()
		.db.insert(auditLog)
		.values(rows.map((row) => ({ channelId: 'UC1', reason: 'test', actor: 'system', ...row })));
}

test('load marks only the latest reversible action per comment as undoable', async () => {
	await seedChannel();
	await seedEntries([
		{ commentId: 'c-hold', action: 'hold', createdAt: '2026-01-01T00:00:01.000Z' },
		{ commentId: 'c-reject', action: 'reject', createdAt: '2026-01-01T00:00:02.000Z' },
		{ commentId: 'c-ban', action: 'ban', createdAt: '2026-01-01T00:00:03.000Z' },
		{ commentId: 'c-delete', action: 'delete', createdAt: '2026-01-01T00:00:04.000Z' },
		{ commentId: 'c-restored', action: 'hold', createdAt: '2026-01-01T00:00:05.000Z' },
		{ commentId: 'c-restored', action: 'restore', createdAt: '2026-01-01T00:00:06.000Z' },
		{ commentId: 'c-approve', action: 'approve', createdAt: '2026-01-01T00:00:07.000Z' }
	]);

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);

	const byComment = new Map(result!.entries.map((e) => [`${e.commentId}:${e.action}`, e.undoable]));
	expect(byComment.get('c-hold:hold')).toBe('full');
	expect(byComment.get('c-reject:reject')).toBe('full');
	expect(byComment.get('c-ban:ban')).toBe('comment-only');
	expect(byComment.get('c-delete:delete')).toBeNull();
	// A superseded action and a restore/approve are never undoable.
	expect(byComment.get('c-restored:hold')).toBeNull();
	expect(byComment.get('c-restored:restore')).toBeNull();
	expect(byComment.get('c-approve:approve')).toBeNull();
});

test('tied timestamps still pick the truly latest action (auto-increment id breaks the tie)', async () => {
	await seedChannel();
	// Same millisecond: insertion order decides — the restore is inserted after
	// the hold, so the hold must NOT be undoable despite the tied createdAt.
	await seedEntries([
		{ commentId: 'c-tied', action: 'hold', createdAt: '2026-01-01T00:00:01.000Z' },
		{ commentId: 'c-tied', action: 'restore', createdAt: '2026-01-01T00:00:01.000Z' }
	]);

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);

	const byAction = new Map(result!.entries.map((e) => [e.action, e.undoable]));
	expect(byAction.get('restore')).toBeNull();
	expect(byAction.get('hold')).toBeNull();
});

test('load projects only the channel fields the page renders — never the credential', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'Ch', refreshTokenEnc: 'enc-secret' });

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);

	expect(result?.ch).toEqual({ id: 'UC1', title: 'Ch' });
	expect(result?.ch).not.toHaveProperty('refreshTokenEnc');
});

test('load on a same-team channel connected by a teammate succeeds', async () => {
	// Tenancy is per-ORG: who connected the channel no longer gates access.
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: 'user-2', orgId: 'org-1', title: 'Ch', refreshTokenEnc: 'enc-secret' });

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);

	expect(result?.ch).toEqual({ id: 'UC1', title: 'Ch' });
});

test('load on a channel owned by another team fails with 404', async () => {
	// The caller personally connected this channel — under another team. The
	// org gate, not the connector, decides access (a per-user check would
	// wrongly pass here).
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, orgId: 'org-2', title: 'Ch', refreshTokenEnc: 'enc-secret' });

	await expect(load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never)).rejects.toMatchObject({ status: 404 });
});

test('load rejects a signed-out request with 401', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'Ch', refreshTokenEnc: 'enc-secret' });

	await expect(load({ params: { id: 'UC1' }, locals: { user: null } } as never)).rejects.toMatchObject({ status: 401 });
});
