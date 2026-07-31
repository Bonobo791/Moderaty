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
			{ id: 'UC1', userId: OWNER.id, title: 'One', refreshTokenEnc: 'enc-1' },
			{ id: 'UC2', userId: OWNER.id, title: 'Two', refreshTokenEnc: 'enc-2' }
		]);
	mocks.env.DRY_RUN = 'true';
	vi.clearAllMocks();
});

const QUEUE_URL = 'http://localhost/channels/UC1/queue';

const OWNER = { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' };

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
		authorChannelId: 'UCa',
		authorName: 'Ann',
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

test('every action rejects a missing commentId with 400 and mutates nothing', async () => {
	await seedComment('c1', 'UC1');
	for (const name of actionNames) {
		const res = await act(name, {});
		expect(res).toMatchObject({ status: 400 });
	}
	await expectNothingDecided('c1', 'pending');
});

test('act fails loudly on another channel comment and changes nothing', async () => {
	await seedComment('c2', 'UC2');
	await expectAllActions404({ commentId: 'c2' });
	await expectNothingDecided('c2', 'pending');
});

test('act fails loudly on a comment that is no longer pending', async () => {
	await seedComment('c3', 'UC1', 'approved');
	await expectAllActions404({ commentId: 'c3' });
	expect((await commentRow('c3'))?.decidedBy).toBe('ai');
	await expectNothingDecided('c3', 'approved');
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
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'rejected', false, 'access-token');
	expect((await commentRow('c1'))?.status).toBe('rejected');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'reject', actor: 'user' });
});

test('act fails loudly on a channel owned by another user and changes nothing', async () => {
	await testDb().db.update(channels).set({ userId: 'user-2' }).where(eq(channels.id, 'UC1'));
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
