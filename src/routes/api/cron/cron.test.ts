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
import { setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels, comments, consents, moderationActions, rules, sessions, users } from '$lib/server/db/schema';

// Synthetic credential fixture — same maintainer-approved exception as
// netlify/cron.test.mjs (2026-07-30, PR #13 review, per AGENTS.md).
const mocks = vi.hoisted(() => ({
	env: { CRON_SECRET: 'test-secret', DRY_RUN: 'true' } as Record<string, string | undefined>,
	runChannel: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/pipeline', () => ({ runChannel: mocks.runChannel }));

import { GET } from './+server';

setupTestDb(['channels', 'users', 'sessions', 'rules', 'comments', 'moderation_actions', 'audit_log', 'consents']);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Seeds a user with one of every owned record, channel inactive (as deletion leaves it). */
async function seedUserWithData(id: string, deletedAt: string | null) {
	await testDb().db.insert(users).values({ id, googleSub: `sub-${id}`, email: `${id}@example.com`, displayName: id, deletedAt });
	await testDb().db.insert(sessions).values({ id: `sess-${id}`, userId: id, expiresAt: new Date(Date.now() + DAY_MS).toISOString() });
	await testDb().db.insert(channels).values({ id: `UC-${id}`, userId: id, title: 'T', refreshTokenEnc: 'enc', active: 0 });
	await testDb().db.insert(rules).values({ channelId: `UC-${id}`, type: 'keyword', pattern: 'spam', action: 'reject' });
	await testDb().db.insert(comments).values({
		id: `c-${id}`,
		channelId: `UC-${id}`,
		authorChannelId: 'a',
		authorName: 'A',
		text: 'hi',
		publishedAt: '2026-01-01T00:00:00.000Z',
		status: 'pending',
		decidedBy: 'none'
	});
	await testDb().db.insert(moderationActions).values({ commentId: `c-${id}`, channelId: `UC-${id}`, action: 'reject', reason: 'r', state: 'pending' });
	await testDb().db.insert(auditLog).values({ channelId: `UC-${id}`, commentId: `c-${id}`, action: 'queue', reason: 'r', actor: 'system' });
	await testDb().db.insert(consents).values({ userId: id, docVersion: '1.0', checkboxText: 'text', ip: '1.2.3.4', userAgent: 'ua' });
}

async function ownedRowCounts(id: string) {
	return {
		sessions: (await testDb().db.select().from(sessions).all()).filter((r) => r.userId === id).length,
		channels: (await testDb().db.select().from(channels).all()).filter((r) => r.userId === id).length,
		rules: (await testDb().db.select().from(rules).all()).filter((r) => r.channelId === `UC-${id}`).length,
		comments: (await testDb().db.select().from(comments).all()).filter((r) => r.channelId === `UC-${id}`).length,
		actions: (await testDb().db.select().from(moderationActions).all()).filter((r) => r.channelId === `UC-${id}`).length,
		audit: (await testDb().db.select().from(auditLog).all()).filter((r) => r.channelId === `UC-${id}`).length,
		consents: (await testDb().db.select().from(consents).all()).filter((r) => r.userId === id).length
	};
}

beforeEach(() => {
	mocks.env.CRON_SECRET = 'test-secret';
	mocks.env.DRY_RUN = 'true';
	vi.clearAllMocks();
});

function call(secret?: { query?: string; bearer?: string }) {
	const url = new URL('http://localhost/api/cron');
	if (secret?.query !== undefined) url.searchParams.set('secret', secret.query);
	const headers: Record<string, string> = {};
	if (secret?.bearer !== undefined) headers.authorization = `Bearer ${secret.bearer}`;
	return GET({ url, request: new Request(url, { headers }) } as never);
}

test('rejects a request with no secret at all', async () => {
	await expect(call()).rejects.toThrowError(expect.objectContaining({ status: 401 }));
});

test('rejects a wrong secret in both query and header', async () => {
	await expect(call({ query: 'wrong' })).rejects.toThrowError(expect.objectContaining({ status: 401 }));
	await expect(call({ bearer: 'wrong' })).rejects.toThrowError(expect.objectContaining({ status: 401 }));
});

test('rejects length-mismatched secrets without throwing a 500', async () => {
	await expect(call({ bearer: 'x' })).rejects.toThrowError(expect.objectContaining({ status: 401 }));
	await expect(call({ bearer: 'test-secret-but-longer' })).rejects.toThrowError(expect.objectContaining({ status: 401 }));
	await expect(call({ bearer: 'test-secrex' })).rejects.toThrowError(expect.objectContaining({ status: 401 }));
});

test('fails loudly when CRON_SECRET is not configured', async () => {
	delete mocks.env.CRON_SECRET;

	await expect(call({ bearer: 'anything' })).rejects.toThrowError(expect.objectContaining({ status: 500 }));
});

test('rejects a malformed Authorization header even with a valid query secret', async () => {
	const url = new URL('http://localhost/api/cron?secret=test-secret');
	const request = new Request(url, { headers: { authorization: 'Basic anything' } });

	await expect(GET({ url, request } as never)).rejects.toThrowError(
		expect.objectContaining({ status: 401 })
	);
});

test.each([
	{ label: 'plan-documented query secret for manual triggers', secret: { query: 'test-secret' } },
	{ label: 'Authorization bearer secret without a query param', secret: { bearer: 'test-secret' } }
])('accepts the $label', async ({ secret }) => {
	const res = await call(secret);

	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({ ok: true, results: {} });
});

test('runs the channel with a server-side deadline inside the caller abort window', async () => {
	await testDb().db.insert(channels).values({ id: 'UC1', title: 'One', refreshTokenEnc: 'enc' });
	const before = Date.now();

	await call({ bearer: 'test-secret' });

	expect(mocks.runChannel).toHaveBeenCalledWith('UC1', expect.objectContaining({
		// The scheduled function aborts at 25s; the server must stop before that.
		deadline: expect.any(Number)
	}));
	const deadline = mocks.runChannel.mock.calls[0][1].deadline;
	expect(deadline - before).toBeGreaterThanOrEqual(19_000);
	expect(deadline - before).toBeLessThanOrEqual(21_000);
});

test('purges a user whose 6-month retention expired, keeping only the consent log', async () => {
	mocks.env.DRY_RUN = 'false';
	await seedUserWithData('old', new Date(Date.now() - 181 * DAY_MS).toISOString());

	const res = await call({ bearer: 'test-secret' });

	expect(await res.json()).toMatchObject({ ok: true, purged: 'old' });
	expect(await ownedRowCounts('old')).toEqual({ sessions: 0, channels: 0, rules: 0, comments: 0, actions: 0, audit: 0, consents: 1 });
	const tombstone = (await testDb().db.select().from(users).all())[0];
	expect(tombstone).toMatchObject({
		id: 'old',
		googleSub: 'deleted:old',
		email: '[deleted]',
		displayName: '[deleted]',
		deletedAt: null // cleared so the tombstone never re-enters the purge queue
	});
});

test('leaves a user inside the retention window untouched', async () => {
	mocks.env.DRY_RUN = 'false';
	await seedUserWithData('recent', new Date(Date.now() - 100 * DAY_MS).toISOString());

	const res = await call({ bearer: 'test-secret' });

	expect(await res.json()).toMatchObject({ ok: true, purged: null });
	expect((await testDb().db.select().from(users).all())[0].googleSub).toBe('sub-recent');
	expect(await ownedRowCounts('recent')).toEqual({ sessions: 1, channels: 1, rules: 1, comments: 1, actions: 1, audit: 1, consents: 1 });
});

test('purges only one expired user per invocation, oldest first (I10)', async () => {
	mocks.env.DRY_RUN = 'false';
	await seedUserWithData('older', new Date(Date.now() - 200 * DAY_MS).toISOString());
	await seedUserWithData('newer', new Date(Date.now() - 190 * DAY_MS).toISOString());

	const first = await call({ bearer: 'test-secret' });

	expect(await first.json()).toMatchObject({ purged: 'older' });
	expect((await testDb().db.select().from(users).all()).find((u) => u.id === 'newer')!.googleSub).toBe('sub-newer');
	expect(await ownedRowCounts('newer')).toEqual({ sessions: 1, channels: 1, rules: 1, comments: 1, actions: 1, audit: 1, consents: 1 });

	// The tombstoned user must not be re-selected: the next invocation drains
	// the remaining expired user instead of starving on 'older'.
	const second = await call({ bearer: 'test-secret' });
	expect(await second.json()).toMatchObject({ purged: 'newer' });
	expect(await ownedRowCounts('newer')).toEqual({ sessions: 0, channels: 0, rules: 0, comments: 0, actions: 0, audit: 0, consents: 1 });
});

test('a mid-purge failure rolls back every delete, leaving the account intact (atomic purge)', async () => {
	mocks.env.DRY_RUN = 'false';
	await seedUserWithData('old', new Date(Date.now() - 181 * DAY_MS).toISOString());
	// Abort the LAST delete of the purge (sessions) so every earlier delete —
	// moderation_actions, comments, audit_log, rules, channels — must roll back
	// if the purge is genuinely transactional.
	await testDb().client.execute(
		`CREATE TRIGGER fail_session_delete BEFORE DELETE ON sessions
		 BEGIN SELECT RAISE(ABORT, 'simulated purge failure'); END`
	);
	try {
		// drizzle wraps the libsql trigger error; the purge must fail loudly.
		await expect(call({ bearer: 'test-secret' })).rejects.toThrowError(/Failed query/);
	} finally {
		await testDb().client.execute('DROP TRIGGER fail_session_delete');
	}

	// Nothing was deleted and the user was not anonymized: the next run retries the full purge.
	expect((await testDb().db.select().from(users).all())[0].googleSub).toBe('sub-old');
	expect(await ownedRowCounts('old')).toEqual({ sessions: 1, channels: 1, rules: 1, comments: 1, actions: 1, audit: 1, consents: 1 });
});

test('purges an expired user with no channels without error', async () => {
	mocks.env.DRY_RUN = 'false';
	const id = 'nochan';
	await testDb().db.insert(users).values({
		id,
		googleSub: `sub-${id}`,
		email: `${id}@example.com`,
		displayName: id,
		deletedAt: new Date(Date.now() - 181 * DAY_MS).toISOString()
	});
	await testDb().db.insert(sessions).values({ id: `sess-${id}`, userId: id, expiresAt: new Date(Date.now() + DAY_MS).toISOString() });
	await testDb().db.insert(consents).values({ userId: id, docVersion: '1.0', checkboxText: 'text', ip: '1.2.3.4', userAgent: 'ua' });

	const res = await call({ bearer: 'test-secret' });

	expect(await res.json()).toMatchObject({ ok: true, purged: id });
	expect(await ownedRowCounts(id)).toEqual({ sessions: 0, channels: 0, rules: 0, comments: 0, actions: 0, audit: 0, consents: 1 });
	expect((await testDb().db.select().from(users).all())[0]).toMatchObject({ googleSub: `deleted:${id}`, deletedAt: null });
});

test('a dry run skips the purge entirely (I8)', async () => {
	await seedUserWithData('old', new Date(Date.now() - 181 * DAY_MS).toISOString());

	const res = await call({ bearer: 'test-secret' });

	expect(await res.json()).toMatchObject({ ok: true, dryRun: true, purged: null });
	expect((await testDb().db.select().from(users).all())[0].googleSub).toBe('sub-old');
	expect(await ownedRowCounts('old')).toEqual({ sessions: 1, channels: 1, rules: 1, comments: 1, actions: 1, audit: 1, consents: 1 });
});
