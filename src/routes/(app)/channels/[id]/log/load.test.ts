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

import { expect, test } from 'vitest';
import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { auditLog, channels } from '$lib/server/db/schema';

import { load } from './+page.server';

setupTestDb(['audit_log', 'channels']);

const OWNER = TEST_OWNER;

const LOG_URL = new URL('http://localhost/channels/UC1/log');

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

test('load returns the maintenance payload during a database outage instead of a 401', async () => {
	// The layout renders the overlay; the child load must not throw on the
	// null-user outage shape.
	const result = await load({ params: { id: 'UC1' }, locals: { user: null, dbDown: true }, url: LOG_URL } as never);
	// Exact payload: the page renders ch.id/title even in the outage shape.
	expect(result).toEqual({ ch: { id: 'UC1', title: '' }, entries: [], maintenance: true });
});

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

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER }, url: LOG_URL } as never);

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

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER }, url: LOG_URL } as never);

	const byAction = new Map(result!.entries.map((e) => [e.action, e.undoable]));
	expect(byAction.get('restore')).toBeNull();
	expect(byAction.get('hold')).toBeNull();
});

test('latest per comment follows the (createdAt, id) order, not insertion order: a skewed-clock row must not steal Undo', async () => {
	await seedChannel();
	// Audit writers stamp createdAt from the app clock; on serverless the
	// SECOND insert (larger id) can carry an EARLIER createdAt than the first.
	// The page sorts createdAt DESC, id DESC, so the first-inserted reject is
	// the displayed latest — and the only undoable row — even though max(id)
	// would crown the later insert.
	await seedEntries([
		{ commentId: 'c-skew', action: 'reject', createdAt: '2026-01-02T00:00:00.000Z' },
		{ commentId: 'c-skew', action: 'hold', createdAt: '2026-01-01T00:00:00.000Z' }
	]);

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER }, url: LOG_URL } as never);

	const byCreatedAt = new Map(result!.entries.map((e) => [e.createdAt, e.undoable]));
	expect(byCreatedAt.get('2026-01-02T00:00:00.000Z')).toBe('full');
	expect(byCreatedAt.get('2026-01-01T00:00:00.000Z')).toBeNull();
});

test('load projects only the channel fields the page renders — never the credential', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'Ch', refreshTokenEnc: 'enc-secret' });

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER }, url: LOG_URL } as never);

	expect(result?.ch).toEqual({ id: 'UC1', title: 'Ch' });
	expect(result?.ch).not.toHaveProperty('refreshTokenEnc');
});

test('load on a same-team channel connected by a teammate succeeds', async () => {
	// Tenancy is per-ORG: who connected the channel no longer gates access.
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: 'user-2', orgId: 'org-1', title: 'Ch', refreshTokenEnc: 'enc-secret' });

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER }, url: LOG_URL } as never);

	expect(result?.ch).toEqual({ id: 'UC1', title: 'Ch' });
});

test('load on a channel owned by another team fails with 404', async () => {
	// The caller personally connected this channel — under another team. The
	// org gate, not the connector, decides access (a per-user check would
	// wrongly pass here).
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, orgId: 'org-2', title: 'Ch', refreshTokenEnc: 'enc-secret' });

	await expect(load({ params: { id: 'UC1' }, locals: { user: OWNER }, url: LOG_URL } as never)).rejects.toMatchObject({ status: 404 });
});

test('load rejects a signed-out request with 401', async () => {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: OWNER.id, orgId: 'org-1', title: 'Ch', refreshTokenEnc: 'enc-secret' });

	await expect(load({ params: { id: 'UC1' }, locals: { user: null }, url: LOG_URL } as never)).rejects.toMatchObject({ status: 401 });
});

test('a dry-run audit row surfaces its stored comment text to the page', async () => {
	// Dry runs never insert into comments (I8); the text on the audit row is
	// what the log page renders for dry-run entries.
	await seedChannel();
	await testDb().db.insert(auditLog).values({
		channelId: 'UC1',
		commentId: 'c-dry',
		action: 'dry-run',
		reason: 'ai score 0.91',
		actor: 'system',
		text: 'previewed comment text',
		createdAt: '2026-01-01T00:00:01.000Z'
	});

	const result = await load({ params: { id: 'UC1' }, locals: { user: OWNER }, url: LOG_URL } as never);

	expect(result!.entries[0]).toMatchObject({ commentId: 'c-dry', action: 'dry-run', text: 'previewed comment text' });
});

// --- keyset pagination (?before=<createdAt>|<id>) --------------------------

const PAGE_SIZE = 200;

function manyEntries(n: number, offsetMs = 0) {
	return Array.from({ length: n }, (_, i) => ({
		commentId: `c-${i}`,
		action: 'approve',
		createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + offsetMs + i * 1000).toISOString()
	}));
}

function loadPage(before?: string) {
	const url = new URL(LOG_URL);
	if (before !== undefined) url.searchParams.set('before', before);
	return load({ params: { id: 'UC1' }, locals: { user: OWNER }, url } as never);
}

test('page 1 returns the newest PAGE_SIZE entries plus a continuation cursor', async () => {
	await seedChannel();
	await seedEntries(manyEntries(PAGE_SIZE + 1));

	const page1 = (await loadPage())!;

	expect(page1.entries).toHaveLength(PAGE_SIZE);
	expect(page1.entries[0].commentId).toBe(`c-${PAGE_SIZE}`); // newest first
	expect(page1.nextCursor).not.toBeNull();
	expect(page1.hasPrev).toBe(false);
});

test('page 2 via the cursor continues strictly older with no overlap, and the last page ends the cursor', async () => {
	await seedChannel();
	await seedEntries(manyEntries(PAGE_SIZE + 50));

	const page1 = (await loadPage())!;
	const page2 = (await loadPage(page1.nextCursor!))!;

	expect(page2.entries).toHaveLength(50);
	expect(page2.hasPrev).toBe(true);
	// Strictly older: the newest page-2 row predates the oldest page-1 row…
	const oldestPage1 = page1.entries[PAGE_SIZE - 1];
	const newestPage2 = page2.entries[0];
	expect(Date.parse(newestPage2.createdAt)).toBeLessThanOrEqual(Date.parse(oldestPage1.createdAt));
	// …with zero overlap.
	const page1Ids = new Set(page1.entries.map((e) => e.id));
	expect(page2.entries.some((e) => page1Ids.has(e.id))).toBe(false);
	// The listing is exhausted — no further cursor.
	expect(page2.nextCursor).toBeNull();
});

test('rows inserted between page loads never shift a cursor page (keyset stability)', async () => {
	await seedChannel();
	await seedEntries(manyEntries(PAGE_SIZE + 1));

	const page1 = (await loadPage())!;
	// Cron writes a brand-new newest row before the user clicks "Older".
	await seedEntries([{ commentId: 'c-brand-new', action: 'approve', createdAt: '2027-01-01T00:00:00.000Z' }]);

	const page2 = (await loadPage(page1.nextCursor!))!;

	// Exactly the one pre-cursor row — the insert above page 1's window does
	// not push a duplicate or shift the page.
	expect(page2.entries.map((e) => e.commentId)).toEqual(['c-0']);
});

test.each([
	{ before: 'garbage' },
	{ before: '2026-01-01T00:00:00.000Z|abc' },
	{ before: 'no-separator' },
	{ before: '' }
])('a malformed cursor "$before" fails loudly with 400', async ({ before }) => {
	await seedChannel();

	await expect(loadPage(before)).rejects.toMatchObject({ status: 400 });
});

test.each([
	// Date.parse accepts both, but neither is the canonical toISOString()
	// form created_at is stored and compared as — lexicographic keyset
	// paging against a non-canonical cursor silently selects the wrong window.
	{ before: '2026-01-01|5' },
	{ before: '2026-01-01T00:00:00+02:00|5' }
])('a parseable but non-canonical cursor "$before" fails loudly with 400', async ({ before }) => {
	await seedChannel();

	await expect(loadPage(before)).rejects.toMatchObject({ status: 400 });
});

test('a page of tied timestamps pages via the id tie-break: page 2 holds exactly the remaining row', async () => {
	await seedChannel();
	// Every row shares one createdAt: without the `id < cursor.id` tie-break
	// the next page's predicate (`createdAt < cursor.ts`) matches nothing.
	const TIED = '2026-01-01T00:00:00.000Z';
	await seedEntries(manyEntries(PAGE_SIZE + 1).map((row) => ({ ...row, createdAt: TIED })));

	const page1 = (await loadPage())!;
	expect(page1.entries).toHaveLength(PAGE_SIZE);
	expect(page1.nextCursor).toBe(`${TIED}|${page1.entries[PAGE_SIZE - 1].id}`);

	const page2 = (await loadPage(page1.nextCursor!))!;
	expect(page2.entries).toHaveLength(1);
	expect(page2.nextCursor).toBeNull();
	const page1Ids = new Set(page1.entries.map((e) => e.id));
	expect(page1Ids.has(page2.entries[0].id)).toBe(false);
});

test('undoable is judged against the whole log, not the page: a superseded action on page 2 offers no undo', async () => {
	await seedChannel();
	// c-old: hold (oldest, lands on page 2) then restore (newest, page 1).
	// c-deep: hold only (lands on page 2, IS its own latest action).
	await seedEntries([
		{ commentId: 'c-old', action: 'hold', createdAt: '2026-01-01T00:00:00.000Z' },
		{ commentId: 'c-deep', action: 'hold', createdAt: '2026-01-01T00:00:01.000Z' },
		...manyEntries(PAGE_SIZE - 1, 2_000),
		{ commentId: 'c-old', action: 'restore', createdAt: '2027-01-01T00:00:00.000Z' }
	]);

	const page1 = (await loadPage())!;
	expect(page1.entries).toHaveLength(PAGE_SIZE);
	const page2 = (await loadPage(page1.nextCursor!))!;

	const byComment = new Map(page2.entries.map((e) => [e.commentId, e.undoable]));
	// The page-2 hold is NOT c-old's latest action (the restore is on page 1).
	expect(byComment.get('c-old')).toBeNull();
	// …but a comment whose true latest action lives on page 2 stays undoable.
	expect(byComment.get('c-deep')).toBe('full');
});
