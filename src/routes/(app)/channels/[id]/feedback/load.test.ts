// Load-level pins for digest history pagination: a long-lived channel's
// backlog must page instead of loading every completed digest at once,
// while ?digest= keeps deep-linking to any complete row (codex #155).

import { expect, test, vi } from 'vitest';
import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { channels, feedbackDigests } from '$lib/server/db/schema';

import { load } from './+page.server';

setupTestDb(['feedback_digests', 'feedback_findings', 'finding_evidence', 'channels']);

const PAGE_URL = new URL('http://localhost/channels/UC1/feedback');
const ctx = (url: URL) => ({ params: { id: 'UC1' }, locals: { user: TEST_OWNER }, url }) as never;

type HistoryResult = {
	digests: { id: number; status: string }[];
	latest: { id: number } | null;
	selected: { id: number } | null;
	currentAttempt: { id: number; status: string } | null;
	historyCursor: number | null;
	historyNext: number | null;
};
const callLoad = async (url: URL) => (await load(ctx(url))) as HistoryResult;

async function seedChannel() {
	await testDb()
		.db.insert(channels)
		.values({ id: 'UC1', userId: TEST_OWNER.id, orgId: 'org-1', title: 'Ch', refreshTokenEnc: 'enc', feedbackEnabled: 1 });
}

async function seedDigests(count: number, status = 'complete') {
	for (let i = 1; i <= count; i++) {
		await testDb()
			.db.insert(feedbackDigests)
			.values({ channelId: 'UC1', windowStart: `2025-0${Math.min(9, Math.ceil(i / 2))}-01`, windowEnd: '2026-01-01', status });
	}
}

test('the history list paginates behind a cursor; ?digest= still deep-links an older row', async () => {
	await seedChannel();
	await seedDigests(30);

	const first = await callLoad(PAGE_URL);
	expect(first.digests).toHaveLength(25);
	// Newest first — ids are monotonic.
	expect(first.digests.at(0)!.id).toBeGreaterThan(first.digests.at(-1)!.id);
	expect(first.historyCursor).toBeNull();
	expect(first.historyNext).toBe(first.digests.at(-1)!.id);

	const second = await callLoad(new URL(`${PAGE_URL}?history=${first.historyNext}`));
	expect(second.digests).toHaveLength(5);
	expect(second.historyCursor).toBe(first.historyNext);
	expect(second.historyNext).toBeNull();

	// A complete digest off the current page stays directly selectable.
	const deepId = second.digests.at(-1)!.id;
	const deep = await callLoad(new URL(`${PAGE_URL}?digest=${deepId}`));
	expect(deep.selected?.id).toBe(deepId);
});

test('a transient row newer than the latest complete rides page 1 only', async () => {
	await seedChannel();
	await seedDigests(26);
	await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2026-01-01', windowEnd: '2026-02-01', status: 'failed', error: 'error' });

	const first = await callLoad(PAGE_URL);
	expect(first.digests).toHaveLength(25);
	expect(first.digests.at(0)!.status).toBe('failed');
	expect(first.digests.at(1)!.status).toBe('complete');

	const second = await callLoad(new URL(`${PAGE_URL}?history=${first.historyNext}`));
	expect(second.digests).toHaveLength(2);
	expect(second.digests.every((d) => d.status === 'complete')).toBe(true);
});

test('a malformed ?history= cursor falls back to the first page', async () => {
	// '', '0', negatives, fractions, non-numbers, and unsafe integers are all
	// invalid cursors — accepting 0/-4 as "id < 0" hides every digest on a
	// dead-end page with no way back (coderabbit/cubic/codeant).
	await seedChannel();
	await seedDigests(30);
	for (const bad of ['', '0', '-4', '1.5', 'abc', '1e20']) {
		const page = await callLoad(new URL(`${PAGE_URL}?history=${bad}`));
		expect(page.digests, `cursor "${bad}"`).toHaveLength(25);
		expect(page.historyCursor, `cursor "${bad}"`).toBeNull();
	}
});

test('the current failed/deferred attempt is reported independently of the history page', async () => {
	// On an older page the transient row is not in `digests` at all — the
	// status banner must still see the current attempt (coderabbit/cubic).
	await seedChannel();
	await seedDigests(30);
	const [failed] = await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2026-01-01', windowEnd: '2026-02-01', status: 'failed', error: 'error' })
		.returning({ id: feedbackDigests.id });

	const first = await callLoad(PAGE_URL);
	expect(first.currentAttempt).toMatchObject({ id: failed.id, status: 'failed' });

	const older = await callLoad(new URL(`${PAGE_URL}?history=${first.historyNext}`));
	expect(older.digests.every((d) => d.status === 'complete')).toBe(true);
	expect(older.currentAttempt).toMatchObject({ id: failed.id, status: 'failed' });
});

test('the history query fetches a bounded page, not the whole backlog', async () => {
	// Pin the bound itself (cubic): removing digestHistoryPage's .limit()
	// would slice AFTER the fetch — every assertion on page shape, cursors,
	// and deep links still passes while the load reads all 60 rows.
	await seedChannel();
	await seedDigests(60);
	const client = testDb().client;
	const originalExecute = client.execute.bind(client);
	const digestRowCounts: number[] = [];
	client.execute = (async (stmt: unknown) => {
		const result = await originalExecute(stmt as never);
		const sqlText = String((stmt as { sql?: string }).sql ?? stmt);
		if (sqlText.includes('from "feedback_digests"')) digestRowCounts.push(result.rows.length);
		return result;
	}) as never;
	try {
		const page = await callLoad(PAGE_URL);
		expect(page.digests).toHaveLength(25);
		// 'latest' reads at most 1 row; the page read carries the +1 lookahead.
		expect(Math.max(...digestRowCounts)).toBeLessThanOrEqual(25 + 1);
	} finally {
		client.execute = originalExecute;
	}
});
