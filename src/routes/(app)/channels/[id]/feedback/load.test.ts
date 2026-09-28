// Load-level pins for digest history pagination: a long-lived channel's
// backlog must page instead of loading every completed digest at once,
// while ?digest= keeps deep-linking to any complete row (codex #155).

import { expect, test } from 'vitest';
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
