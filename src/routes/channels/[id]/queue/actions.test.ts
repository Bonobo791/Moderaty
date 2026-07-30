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

import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createTestDb, type TestDb } from '$lib/server/testdb';
import { auditLog, channels, comments } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	db: null as unknown,
	env: { DRY_RUN: 'true' } as Record<string, string | undefined>,
	refreshAccessToken: vi.fn(async () => 'access-token'),
	setModerationStatus: vi.fn(async () => {}),
	deleteComment: vi.fn(async () => {})
}));

vi.mock('$lib/server/db', () => ({
	get db() {
		return mocks.db;
	}
}));
vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/crypto', () => ({ decrypt: vi.fn(() => 'decrypted-refresh-token') }));
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: mocks.refreshAccessToken,
	setModerationStatus: mocks.setModerationStatus,
	deleteComment: mocks.deleteComment
}));

import { actions } from './+page.server';

let testDb: TestDb;

beforeAll(async () => {
	testDb = await createTestDb();
	mocks.db = testDb.db;
});

beforeEach(async () => {
	await testDb.client.batch([
		'DELETE FROM audit_log',
		'DELETE FROM comments',
		'DELETE FROM channels'
	]);
	await testDb.db
		.insert(channels)
		.values({ id: 'UC1', title: 'One', refreshTokenEnc: 'enc-1' });
	await testDb.db
		.insert(channels)
		.values({ id: 'UC2', title: 'Two', refreshTokenEnc: 'enc-2' });
	mocks.env.DRY_RUN = 'true';
	vi.clearAllMocks();
});

function post(fields: Record<string, string>): Request {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return new Request('http://localhost/channels/UC1/queue', { method: 'POST', body: form });
}

async function seedComment(id: string, channelId: string, status = 'pending') {
	await testDb.db.insert(comments).values({
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
	return testDb.db.select().from(comments).where(eq(comments.id, id)).get();
}

async function auditRows() {
	return testDb.db.select().from(auditLog).all();
}

const actionNames = ['approve', 'reject', 'del', 'ban'] as const;

test('every action rejects a missing commentId with 400 and mutates nothing', async () => {
	await seedComment('c1', 'UC1');
	for (const name of actionNames) {
		const res = await actions[name]({ params: { id: 'UC1' }, request: post({}) } as never);
		expect(res).toMatchObject({ status: 400 });
	}
	expect((await commentRow('c1'))?.status).toBe('pending');
	expect(await auditRows()).toHaveLength(0);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
});

test('act fails loudly on another channel comment and changes nothing', async () => {
	await seedComment('c2', 'UC2');
	for (const name of actionNames) {
		await expect(
			actions[name]({ params: { id: 'UC1' }, request: post({ commentId: 'c2' }) } as never)
		).rejects.toThrowError(expect.objectContaining({ status: 404 }));
	}
	expect((await commentRow('c2'))?.status).toBe('pending');
	expect(await auditRows()).toHaveLength(0);
	expect(mocks.setModerationStatus).not.toHaveBeenCalled();
	expect(mocks.deleteComment).not.toHaveBeenCalled();
});

test('act fails loudly on a comment that is no longer pending', async () => {
	await seedComment('c3', 'UC1', 'approved');
	await expect(
		actions.approve({ params: { id: 'UC1' }, request: post({ commentId: 'c3' }) } as never)
	).rejects.toThrowError(expect.objectContaining({ status: 404 }));
	expect((await commentRow('c3'))?.status).toBe('approved');
	expect((await commentRow('c3'))?.decidedBy).toBe('ai');
	expect(await auditRows()).toHaveLength(0);
});

test('approve in DRY_RUN finalizes locally, audits dry-run, and skips YouTube', async () => {
	await seedComment('c1', 'UC1');
	await actions.approve({ params: { id: 'UC1' }, request: post({ commentId: 'c1' }) } as never);

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
	await actions.reject({ params: { id: 'UC1' }, request: post({ commentId: 'c1' }) } as never);

	expect(mocks.refreshAccessToken).toHaveBeenCalledWith('decrypted-refresh-token');
	expect(mocks.setModerationStatus).toHaveBeenCalledWith(['c1'], 'rejected', false, 'access-token');
	expect((await commentRow('c1'))?.status).toBe('rejected');

	const audits = await auditRows();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ channelId: 'UC1', commentId: 'c1', action: 'reject', actor: 'user' });
});
