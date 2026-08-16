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
import { TEST_OWNER, postForm, setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, comments } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	env: { DRY_RUN: 'true' } as Record<string, string | undefined>,
	refreshAccessToken: vi.fn(async () => 'access-token'),
	setModerationStatus: vi.fn(async () => {}),
	deleteComment: vi.fn(async () => {})
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/crypto', () => ({ decrypt: vi.fn(() => 'decrypted-refresh-token') }));
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: mocks.refreshAccessToken,
	setModerationStatus: mocks.setModerationStatus,
	deleteComment: mocks.deleteComment
}));

import { actions, load } from './+page.server';

setupTestDb(['audit_log', 'comments', 'channels']);

beforeEach(async () => {
	await testDb()
		.db.insert(channels)
		.values([
			{ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'One', refreshTokenEnc: 'enc-1' },
			{ id: 'UC2', userId: OWNER.id, orgId: 'org-1', title: 'Two', refreshTokenEnc: 'enc-2' }
		]);
	mocks.env.DRY_RUN = 'true';
	vi.clearAllMocks();
});

const QUEUE_URL = 'http://localhost/channels/UC1/queue';

const OWNER = TEST_OWNER;

const actionNames = ['approve', 'reject', 'del', 'ban'] as const;

function act(name: (typeof actionNames)[number], fields: Record<string, string>, channelId = 'UC1', user: typeof OWNER | null = OWNER) {
	return actions[name]({ params: { id: channelId }, request: postForm(fields, QUEUE_URL), locals: { user } } as never);
}

async function expectAllActions404(fields: Record<string, string>) {
	for (const name of actionNames) {
		await expect(act(name, fields)).rejects.toThrowError(expect.objectContaining({ status: 404 }));
	}
}

async function seedComment(id: string, channelId: string, status = 'pending') {
	await testDb().db.insert(comments).values({
		id,
		channelId,
		text: 'hello',
		publishedAt: '2026-01-01T00:00:00Z',
		status,
		decidedBy: 'ai'
	});
}

async function commentRow(id: string) {
	return testDb().db.select().from(comments).where(eq(comments.id, id)).get();
}

async function auditRows() {
	return testDb().db.select().from(auditLog).all();
}

async function expectNothingDecided(id: string, status: string) {
	expect((await commentRow(id))?.status).toBe(status);
	expect(await auditRows()).toHaveLength(0);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
}

test('load projects only the channel fields the page renders — never the credential', async () => {
	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);
	expect(result?.ch).toEqual({ id: 'UC1', title: 'One' });
	expect(result?.ch).not.toHaveProperty('refreshTokenEnc');
});

test('every action rejects a signed-out request with 401 before validating the form', async () => {
	for (const name of actionNames) {
		await expect(act(name, {}, 'UC1', null)).rejects.toThrowError(expect.objectContaining({ status: 401 }));
	}
});

test('every action rejects a missing commentId with 400 and mutates nothing', async () => {
	await seedComment('c1', 'UC1');
	for (const name of actionNames) {
		const res = await act(name, {});
		expect(res).toMatchObject({ status: 400, data: { error: 'Invalid comment ID' } });
	}
	await expectNothingDecided('c1', 'pending');
});

test('a whitespace-padded commentId is trimmed before lookup', async () => {
	await seedComment('c1', 'UC1');
	const res = await act('approve', { commentId: '  c1\t' });
	expect(res).toMatchObject({ success: 'Approved — recorded in audit log.' });
	expect((await commentRow('c1'))?.status).toBe('approved');
});

test('act fails loudly on another channel comment and changes nothing', async () => {
	await seedComment('c2', 'UC2');
	await expectAllActions404({ commentId: 'c2' });
	await expectNothingDecided('c2', 'pending');
});

test('a 404 on an unknown pending comment names the problem', async () => {
	await expect(act('approve', { commentId: 'nope' })).rejects.toThrowError(
		expect.objectContaining({ status: 404, body: { message: 'pending comment not found in this channel' } })
	);
});

test('act fails loudly on a comment that is no longer pending', async () => {
	await seedComment('c3', 'UC1', 'approved');
	await expectAllActions404({ commentId: 'c3' });
	expect((await commentRow('c3'))?.decidedBy).toBe('ai');
	await expectNothingDecided('c3', 'approved');
});

test('a second act on an already-claimed comment 404s and audits nothing new', async () => {
	await seedComment('c1', 'UC1');
	await act('approve', { commentId: 'c1' });

	await expect(act('reject', { commentId: 'c1' })).rejects.toThrowError(expect.objectContaining({ status: 404 }));

	expect((await commentRow('c1'))?.status).toBe('approved');
	expect(await auditRows()).toHaveLength(1);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
});

test('a failed YouTube call releases the claim so the action stays retryable', async () => {
	mocks.env.DRY_RUN = 'false';
	mocks.setModerationStatus.mockRejectedValueOnce(new Error('youtube 500'));
	await seedComment('c1', 'UC1');

	await expect(act('reject', { commentId: 'c1' })).rejects.toThrowError('youtube 500');

	expect(await commentRow('c1')).toMatchObject({ status: 'pending', decidedBy: 'none' });
	expect(await auditRows()).toHaveLength(0);

	// The retry goes through.
	const res = await act('reject', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Rejected — recorded in audit log.' });
	expect((await commentRow('c1'))?.status).toBe('rejected');
});

test('approve in DRY_RUN finalizes locally, audits dry-run, and skips YouTube', async () => {
	await seedComment('c1', 'UC1');
	const res = await act('approve', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Approved — recorded in audit log.' });

	const row = await commentRow('c1');
	expect(row?.status).toBe('approved');
	expect(row?.decidedBy).toBe('human');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'dry-run', actor: 'user' });

	expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
});

test('reject outside DRY_RUN calls YouTube and audits reject', async () => {
	mocks.env.DRY_RUN = 'false';
	await seedComment('c1', 'UC1');
	const res = await act('reject', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Rejected — recorded in audit log.' });

	expect(mocks.refreshAccessToken).toHaveBeenCalledWith('decrypted-refresh-token');
	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(1);
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'rejected', false, 'access-token');
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect((await commentRow('c1'))?.status).toBe('rejected');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	// authorHandle is null: manual actions have no handle source (the author's
	// name is never persisted on the comment row by design).
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'reject', reason: 'manual review', actor: 'user', authorHandle: null });
});

test('approve outside DRY_RUN skips YouTube entirely and audits approve', async () => {
	mocks.env.DRY_RUN = 'false';
	await seedComment('c1', 'UC1');
	const res = await act('approve', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Approved — recorded in audit log.' });

	expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect((await commentRow('c1'))?.status).toBe('approved');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'approve', reason: 'manual review', actor: 'user' });
});

test('del outside DRY_RUN deletes on YouTube, marks deleted, and audits delete', async () => {
	mocks.env.DRY_RUN = 'false';
	await seedComment('c1', 'UC1');
	const res = await act('del', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Deleted — recorded in audit log.' });

	expect(mocks.refreshAccessToken).toHaveBeenCalledWith('decrypted-refresh-token');
	expect(mocks.deleteComment).toHaveBeenCalledTimes(1);
	expect(mocks.deleteComment).toHaveBeenCalledWith('c1', 'access-token');
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect((await commentRow('c1'))?.status).toBe('deleted');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'delete', reason: 'manual review', actor: 'user' });
});

test('ban outside DRY_RUN rejects with the author ban on YouTube and audits ban', async () => {
	mocks.env.DRY_RUN = 'false';
	await seedComment('c1', 'UC1');
	const res = await act('ban', { commentId: 'c1' });
	expect(res).toMatchObject({ success: 'Author banned — recorded in audit log.' });

	expect(mocks.refreshAccessToken).toHaveBeenCalledWith('decrypted-refresh-token');
	expect(mocks.setModerationStatus).toHaveBeenCalledTimes(1);
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'rejected', true, 'access-token');
	expect(mocks.deleteComment).not.toHaveBeenCalled();
	expect((await commentRow('c1'))?.status).toBe('rejected');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'ban', reason: 'manual review', actor: 'user' });
});

test('load returns only this channel’s pending comments', async () => {
	await seedComment('c-pending', 'UC1', 'pending');
	await seedComment('c-approved', 'UC1', 'approved');
	await seedComment('c-other', 'UC2', 'pending');

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER } } as never);

	expect(result?.pending.map((row) => row.id)).toEqual(['c-pending']);
});

test('act fails loudly on a channel owned by another team and changes nothing', async () => {
	// The caller personally connected UC1 — under a different team. The org
	// gate must still 404 it (a per-user check would wrongly pass here).
	await testDb().db.update(channels).set({ orgId: 'org-2' }).where(eq(channels.id, 'UC1'));
	await seedComment('c9', 'UC1');
	for (const name of actionNames) {
		await expect(act(name, { commentId: 'c9' })).rejects.toThrowError(expect.objectContaining({ status: 404 }));
	}
	await expectNothingDecided('c9', 'pending');
});

test('act rejects a signed-out request with 401', async () => {
	await seedComment('c8', 'UC1');
	for (const name of actionNames) {
		await expect(act(name, { commentId: 'c8' }, 'UC1', null)).rejects.toThrowError(expect.objectContaining({ status: 401 }));
	}
	await expectNothingDecided('c8', 'pending');
});
