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

import { beforeEach, expect, test, vi } from 'vitest';
import { postForm, setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, comments } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	env: { DRY_RUN: 'false' } as Record<string, string | undefined>,
	refreshAccessToken: vi.fn(async () => 'access-token'),
	setModerationStatus: vi.fn(async () => {})
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/crypto', () => ({ decrypt: vi.fn(() => 'decrypted-refresh-token') }));
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: mocks.refreshAccessToken,
	setModerationStatus: mocks.setModerationStatus
}));

import { actions } from './+page.server';

setupTestDb(['audit_log', 'comments', 'channels']);

const OWNER = { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' };
const LOG_URL = 'http://localhost/channels/UC1/log';

beforeEach(async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, title: 'One', refreshTokenEnc: 'enc-1' });
	mocks.env.DRY_RUN = 'false';
	vi.clearAllMocks();
});

async function seedComment(id: string, status: string, priorAction: string) {
	await testDb().db.insert(comments).values({
		id,
		channelId: 'UC1',
		text: 'hello',
		publishedAt: '2026-01-01T00:00:00Z',
		status,
		decidedBy: 'ai'
	});
	await testDb()
		.db.insert(auditLog)
		.values({ channelId: 'UC1', commentId: id, action: priorAction, reason: 'ai score 0.91', actor: 'system' });
}

function undo(commentId: string | null, channelId = 'UC1', user: typeof OWNER | null = OWNER) {
	return actions.undo({
		params: { id: channelId },
		request: postForm(commentId === null ? {} : { commentId }, LOG_URL),
		locals: { user }
	} as never);
}

async function commentRow(id: string) {
	return testDb().db.select().from(comments).where(eq(comments.id, id)).get();
}

test('undo restores a rejected comment at YouTube and records the restore', async () => {
	await seedComment('c1', 'rejected', 'reject');

	const res = await undo('c1');

	expect(res).toMatchObject({ success: expect.stringContaining('estored') });
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'published', false, 'access-token');
	expect(await commentRow('c1')).toMatchObject({ status: 'approved', decidedBy: 'human' });
	expect(await testDb().db.select().from(auditLog).all()).toContainEqual(
		expect.objectContaining({ commentId: 'c1', action: 'restore', reason: 'undo of reject', actor: 'user' })
	);
});

test('undo of a ban restores the comment and names the original action', async () => {
	await seedComment('c1', 'rejected', 'ban');

	await undo('c1');

	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'published', false, 'access-token');
	expect(await commentRow('c1')).toMatchObject({ status: 'approved' });
	expect(await testDb().db.select().from(auditLog).all()).toContainEqual(
		expect.objectContaining({ commentId: 'c1', action: 'restore', reason: 'undo of ban', actor: 'user' })
	);
});

test('undo on a deleted comment 404s and changes nothing', async () => {
	await seedComment('c1', 'deleted', 'delete');

	await expect(undo('c1')).rejects.toMatchObject({ status: 404 });

	expect(await commentRow('c1')).toMatchObject({ status: 'deleted' });
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(await testDb().db.select().from(auditLog).all()).toHaveLength(1); // only the seeded row
});

test('a YouTube failure releases the claim and fails loudly', async () => {
	await seedComment('c1', 'rejected', 'reject');
	mocks.setModerationStatus.mockRejectedValueOnce(new Error('YouTube refused the transition'));

	await expect(undo('c1')).rejects.toThrow('YouTube refused the transition');

	// Back to the pre-undo state, so the action stays retryable.
	expect(await commentRow('c1')).toMatchObject({ status: 'rejected', decidedBy: 'ai' });
	expect(await testDb().db.select().from(auditLog).all()).toHaveLength(1);
});

test('a dry run records a dry-run audit row and makes no YouTube call', async () => {
	mocks.env.DRY_RUN = 'true';
	await seedComment('c1', 'held', 'hold');

	await undo('c1');

	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(await commentRow('c1')).toMatchObject({ status: 'approved', decidedBy: 'human' });
	expect(await testDb().db.select().from(auditLog).all()).toContainEqual(
		expect.objectContaining({ commentId: 'c1', action: 'dry-run', actor: 'user' })
	);
});

test('undo rejects a signed-out request with 401', async () => {
	await expect(undo('c1', 'UC1', null)).rejects.toMatchObject({ status: 401 });
});

test('undo on another user\'s channel 404s without leaking existence', async () => {
	await seedComment('c1', 'rejected', 'reject');

	await expect(undo('c1', 'UC2')).rejects.toMatchObject({ status: 404 });
	expect(await commentRow('c1')).toMatchObject({ status: 'rejected' });
});

test('undo without a comment id fails with 400', async () => {
	const res = await undo(null);
	expect(res).toMatchObject({ status: 400 });
});
