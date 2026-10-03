// Load-level pins for digest history pagination: a long-lived channel's
// backlog must page instead of loading every completed digest at once,
// while ?digest= keeps deep-linking to any complete row (codex #155).

import { expect, test, vi } from 'vitest';
import { TEST_OWNER, setupTestDb, testDb } from '$lib/server/testdb';
import { channels, feedbackDigests, feedbackFindings, findingEvidence } from '$lib/server/db/schema';

import { load } from './+page.server';

setupTestDb(['feedback_digests', 'feedback_findings', 'finding_evidence', 'channels']);

const PAGE_URL = new URL('http://localhost/channels/UC1/feedback');
const ctx = (url: URL) => ({ params: { id: 'UC1' }, locals: { user: TEST_OWNER }, url }) as never;

type HistoryResult = {
	digests: { id: number; status: string }[];
	latest: { id: number } | null;
	selected: { id: number; status: string } | null;
	currentAttempt: { id: number; status: string } | null;
	previewAttempt: { id: number; status: string } | null;
	historyCursor: number | null;
	historyNext: number | null;
	findings: { summary: string; evidence: { sanitizedExcerpt: string }[] }[];
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

test('preview rows list in the feed but never become the attempt banner', async () => {
	// 'dry-run' is a permanent feed row; 'dry-run-pending'/'dry-run-failed'
	// list while newer than the latest complete (MOD-232). None is attempt
	// state (MOD-229): they must not hijack the failed/deferred banner.
	await seedChannel();
	const [failed] = await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2026-01-01', windowEnd: '2026-02-01', status: 'failed', error: 'error' })
		.returning({ id: feedbackDigests.id });
	for (const status of ['dry-run', 'dry-run-pending', 'dry-run-failed']) {
		await testDb()
			.db.insert(feedbackDigests)
			.values({ channelId: 'UC1', windowStart: '2026-03-01', windowEnd: '2026-04-01', status });
	}

	const page = await callLoad(PAGE_URL);
	expect(page.currentAttempt).toMatchObject({ id: failed.id, status: 'failed' });
	// No complete digest → every row is newer than the latest complete.
	expect(page.digests.map((d) => d.status)).toEqual(['dry-run-failed', 'dry-run-pending', 'dry-run', 'failed']);
});

test('a finished preview stays in the feed after later complete digests land', async () => {
	// 'dry-run' is permanent history — a paid run landing after the preview
	// must not push the free result out of the feed (MOD-232).
	await seedChannel();
	await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2026-01-01', windowEnd: '2026-02-01', status: 'dry-run' });
	await seedDigests(1);

	const page = await callLoad(PAGE_URL);
	expect(page.digests.map((d) => d.status)).toEqual(['complete', 'dry-run']);
});

test('pending and failed previews ride page 1 only, like other transient rows', async () => {
	// Preview lifecycle rows are not permanent feed rows — they surface only
	// while newer than the latest complete digest (MOD-232).
	await seedChannel();
	await seedDigests(26);
	for (const status of ['dry-run-pending', 'dry-run-failed']) {
		await testDb()
			.db.insert(feedbackDigests)
			.values({ channelId: 'UC1', windowStart: '2026-03-01', windowEnd: '2026-04-01', status });
	}

	const first = await callLoad(PAGE_URL);
	expect(first.digests).toHaveLength(25);
	expect(first.digests.slice(0, 2).map((d) => d.status)).toEqual(['dry-run-failed', 'dry-run-pending']);

	const second = await callLoad(new URL(`${PAGE_URL}?history=${first.historyNext}`));
	expect(second.digests.every((d) => d.status === 'complete')).toBe(true);
});

test('the preview lifecycle row is reported independently of the history page', async () => {
	// MOD-233: the running-banner row must reach the page even when the
	// user is paging older digest history — same independence as
	// currentAttempt, but for preview lifecycle state.
	await seedChannel();
	await seedDigests(30);
	const [pending] = await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2026-03-01', windowEnd: '2026-04-01', status: 'dry-run-pending' })
		.returning({ id: feedbackDigests.id });

	const first = await callLoad(PAGE_URL);
	expect(first.previewAttempt).toMatchObject({ id: pending.id, status: 'dry-run-pending' });
	// It is NOT the transient attempt banner — paid attempt state stays separate.
	expect(first.currentAttempt).toBeNull();

	const older = await callLoad(new URL(`${PAGE_URL}?history=${first.historyNext}`));
	expect(older.digests.every((d) => d.status === 'complete')).toBe(true);
	expect(older.previewAttempt).toMatchObject({ id: pending.id, status: 'dry-run-pending' });
});

test('a pending preview stays visible even when a paid digest lands after it', async () => {
	// The preview is live lifecycle state, not history: if it deadline-aborts
	// and a paid digest completes before the retry tick, its id is older than
	// the newest complete — an id-cutoff would hide the running banner and,
	// if the retry later failed, the spent-preview notice too (gitar+cubic+
	// codex+coderabbit, PR #181).
	await seedChannel();
	const [pending] = await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2026-01-01', windowEnd: '2026-02-01', status: 'dry-run-pending' })
		.returning({ id: feedbackDigests.id });
	await seedDigests(1); // a complete digest with a NEWER id

	const page = await callLoad(PAGE_URL);
	expect(page.previewAttempt).toMatchObject({ id: pending.id, status: 'dry-run-pending' });
});

test('a preview lifecycle row older than the latest complete digest is stale — no banner', async () => {
	// Same staleness rule as currentAttempt: once a paid digest lands after
	// the failed preview, the spent-preview banner is history.
	await seedChannel();
	await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2025-01-01', windowEnd: '2025-02-01', status: 'dry-run-failed', error: 'preview' });
	await seedDigests(1);

	const page = await callLoad(PAGE_URL);
	expect(page.previewAttempt).toBeNull();
});

test('?digest= selects a finished preview; a pending or unknown id falls back', async () => {
	await seedChannel();
	const [complete] = await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2026-01-01', windowEnd: '2026-02-01', status: 'complete' })
		.returning({ id: feedbackDigests.id });
	const [dryRun] = await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2026-02-01', windowEnd: '2026-03-01', status: 'dry-run' })
		.returning({ id: feedbackDigests.id });
	const [pending] = await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2026-03-01', windowEnd: '2026-04-01', status: 'dry-run-pending' })
		.returning({ id: feedbackDigests.id });

	expect((await callLoad(new URL(`${PAGE_URL}?digest=${dryRun.id}`))).selected?.id).toBe(dryRun.id);
	// A pending preview is not a finished result — never selectable; the
	// forged/unknown id falls back to the latest valid selection.
	expect((await callLoad(new URL(`${PAGE_URL}?digest=${pending.id}`))).selected?.id).toBe(complete.id);
	expect((await callLoad(new URL(`${PAGE_URL}?digest=99999`))).selected?.id).toBe(complete.id);
});

test('with no complete digest the newest finished preview is selected and its findings render', async () => {
	// The free dry run is the channel's first digest view: without a paid
	// digest the newest 'dry-run' row is selected so its findings render
	// without needing a ?digest= deep link (MOD-232).
	await seedChannel();
	const [older] = await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2026-01-01', windowEnd: '2026-02-01', status: 'dry-run' })
		.returning({ id: feedbackDigests.id });
	const [dryRun] = await testDb()
		.db.insert(feedbackDigests)
		.values({ channelId: 'UC1', windowStart: '2026-02-01', windowEnd: '2026-03-01', status: 'dry-run' })
		.returning({ id: feedbackDigests.id });
	const [finding] = await testDb()
		.db.insert(feedbackFindings)
		.values({ digestId: dryRun.id, category: 'question', summary: 'preview finding', supporterCount: 2 })
		.returning({ id: feedbackFindings.id });
	await testDb()
		.db.insert(findingEvidence)
		.values({ findingId: finding.id, commentId: 'preview-only', sanitizedExcerpt: 'preview evidence', hasAbuse: 0, sourceText: 'raw preview text' });

	const page = await callLoad(PAGE_URL);
	expect(page.currentAttempt).toBeNull();
	expect(page.latest).toBeNull();
	expect(page.selected).toMatchObject({ id: dryRun.id, status: 'dry-run' });
	expect(page.selected?.id).not.toBe(older.id);
	expect(page.findings).toHaveLength(1);
	expect(page.findings[0].evidence[0].sanitizedExcerpt).toBe('preview evidence');
	// The default load stays concealed-only — pinned sourceText never ships.
	expect(JSON.stringify(page)).not.toContain('raw preview text');
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
