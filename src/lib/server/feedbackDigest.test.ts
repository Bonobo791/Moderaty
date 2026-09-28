import { beforeEach, expect, test, vi } from 'vitest';
import { eq, isNull } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	env: { OPENAI_API_KEY: 'test-openai-key', DRY_RUN: 'false' } as Record<string, string | undefined>,
	decrypt: vi.fn((enc: string) => `decrypted:${enc}`),
	fetchNewComments: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/crypto', () => ({ decrypt: mocks.decrypt }));
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: vi.fn(async () => 'access-token'),
	fetchNewComments: mocks.fetchNewComments
}));

import { setupTestDb, testDb } from '$lib/server/testdb';
import { channels, comments, creditTransactions, feedbackDigests, feedbackFindings, feedbackHistoryComments, findingEvidence, organizations } from '$lib/server/db/schema';
import { digestDue, generateFeedbackDigest, previewFeedbackDigest } from './feedbackDigest';
import { CONCEALED_MESSAGE } from './feedbackSanitize';

setupTestDb(['finding_evidence', 'feedback_findings', 'feedback_digests', 'feedback_history_comments', 'comments', 'channels', 'organizations', 'credit_transactions']);

// fetch mock: classify each comment from its text embedded in the prompt.
// Per-test RESPONSES maps comment-text → classification JSON; anything
// unmapped gets a 'none' verdict.
let RESPONSES: Record<string, { category: string; hasAbuse: boolean; claim: string }> = {};
let fetchFailures: Record<string, string> = {};
let beforeClassify: (() => Promise<void>) | undefined;

function installFetch() {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: { body?: string }) => {
			const body = JSON.parse(String(init.body));
			const user = body.messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';
			const text = user.slice(user.indexOf('\n\nComment: ') + '\n\nComment: '.length, user.lastIndexOf('\n</'));
			// A malformed 200 fails the item immediately — a 5xx would go
			// through fetchWithRetry's backoff and slow the suite.
			if (fetchFailures[text]) return new Response('not json', { status: 200 });
			const verdict = RESPONSES[text] ?? { category: 'none', hasAbuse: false, claim: '' };
			await beforeClassify?.();
			return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), { status: 200 });
		})
	);
}

async function seedChannel(id: string, over: Record<string, unknown> = {}) {
	await testDb().db.insert(channels).values({ id, userId: 'user-1', orgId: 'org-1', title: id, refreshTokenEnc: 'enc', ...over });
}

async function seedOrg(id: string, over: Record<string, unknown> = {}) {
	await testDb().db.insert(organizations).values({ id, name: id, ...over });
}

async function seedComment(id: string, channelId: string, text: string, publishedAt: string) {
	await testDb().db.insert(comments).values({ id, channelId, text, publishedAt, status: 'approved', decidedBy: 'ai' });
}

beforeEach(async () => {
	RESPONSES = {};
	fetchFailures = {};
	beforeClassify = undefined;
	mocks.env.DRY_RUN = 'false';
	vi.clearAllMocks();
	mocks.fetchNewComments.mockReset();
	installFetch();
	// Every seeded channel attaches to org-1 — a bare 'free' org with a NULL
	// balance is unmetered (no purchases), so plain tests run charge-free.
	await seedOrg('org-1');
});

test('disabled channel skips without writing anything', async () => {
	await seedChannel('UC1', { feedbackEnabled: 0, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-2' });
	await seedComment('c1', 'UC1', 'when is the next video', '2026-01-05T00:00:00.000Z');
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result.status).toBe('skipped');
	expect(await testDb().db.select().from(feedbackDigests).all()).toHaveLength(0);
	expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())).toMatchObject({ feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-2' });
	expect(mocks.fetchNewComments).not.toHaveBeenCalled();
});

test('a missing channel throws loudly', async () => {
	await expect(generateFeedbackDigest('UC-nope')).rejects.toThrow('channel not found');
});

test('dry run writes no digest rows', async () => {
	mocks.env.DRY_RUN = 'true';
	await seedChannel('UC1', { feedbackEnabled: 1 });
	await seedComment('c1', 'UC1', 'when is the next video', '2026-01-05T00:00:00.000Z');
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result.status).toBe('dry-run');
	expect(await testDb().db.select().from(feedbackDigests).all()).toHaveLength(0);
});

test('an invalid DRY_RUN value throws loudly', async () => {
	mocks.env.DRY_RUN = 'yes';
	await seedChannel('UC1', { feedbackEnabled: 1 });
	await expect(generateFeedbackDigest('UC1')).rejects.toThrow('DRY_RUN must be true or false');
});

test('no new comments stamps the rotation and writes no digest', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1 });
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result.status).toBe('empty');
	const ch = await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get();
	expect(ch?.feedbackLastDigestAt).toBeTruthy();
	expect(await testDb().db.select().from(feedbackDigests).all()).toHaveLength(0);
});

test('a complete digest writes findings + sanitized evidence in one transaction', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1 });
	const texts = [
		'when is the next video?',
		'when is the next video coming',
		'next video when?',
		'you idiot, the audio at 3:00 is blown',
		'the audio at 3:00 is blown out',
		'audio blows at 3:00'
	];
	for (const [i, text] of texts.entries()) {
		await seedComment(`c${i}`, 'UC1', text, `2026-01-0${i + 1}T00:00:00.000Z`);
	}
	RESPONSES = {
		'when is the next video?': { category: 'question', hasAbuse: false, claim: 'when is the next video' },
		'when is the next video coming': { category: 'question', hasAbuse: false, claim: 'when is the next video' },
		'next video when?': { category: 'question', hasAbuse: false, claim: 'when is the next video' },
		'you idiot, the audio at 3:00 is blown': { category: 'criticism', hasAbuse: true, claim: 'the audio at 3:00 is blown' },
		'the audio at 3:00 is blown out': { category: 'criticism', hasAbuse: false, claim: 'the audio at 3:00 is blown' },
		'audio blows at 3:00': { category: 'criticism', hasAbuse: false, claim: 'the audio at 3:00 is blown' }
	};

	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result).toMatchObject({ status: 'complete', commentsClassified: 6, commentsFailed: 0, findings: 2 });

	const digests = await testDb().db.select().from(feedbackDigests).all();
	expect(digests).toHaveLength(1);
	expect(digests[0]).toMatchObject({ status: 'complete', commentsClassified: 6, pooledCount: 0 });

	const findings = await testDb().db.select().from(feedbackFindings).all();
	expect(findings).toHaveLength(2);
	const criticism = findings.find((f) => f.category === 'criticism')!;
	expect(criticism.summary).toBe('3 comments criticized: the audio at 3:00 is blown');
	expect(criticism.supporterCount).toBe(3);

	const evidence = await testDb().db.select().from(findingEvidence).where(eq(findingEvidence.findingId, criticism.id)).all();
	expect(evidence).toHaveLength(3);
	// A flagged comment conceals outright — the lexicon can never prove it
	// masked EVERY insult, so a partial mask still risks leaking an
	// unlisted slur (cubic+codex). The claim survives in the summary above.
	const abusiveRow = evidence.find((e) => e.hasAbuse === 1)!;
	expect(abusiveRow.sanitizedExcerpt).toBe(CONCEALED_MESSAGE);
	// Clean supporters lead the evidence order.
	expect(evidence[0].hasAbuse).toBe(0);
});

test('below-threshold themes pool into the count-only figure', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1 });
	await seedComment('c1', 'UC1', 'solo question', '2026-01-01T00:00:00.000Z');
	RESPONSES = { 'solo question': { category: 'question', hasAbuse: false, claim: 'a lone question' } };
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result).toMatchObject({ status: 'complete', findings: 0, pooled: 1 });
	const digest = await testDb().db.select().from(feedbackDigests).get();
	expect(digest?.pooledCount).toBe(1);
});

test('per-comment classification failures are counted, not fatal', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1 });
	await seedComment('c1', 'UC1', 'ok comment', '2026-01-01T00:00:00.000Z');
	await seedComment('c2', 'UC1', 'broken comment', '2026-01-02T00:00:00.000Z');
	fetchFailures = { 'broken comment': 'boom' };
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result).toMatchObject({ status: 'complete', commentsClassified: 1, commentsFailed: 1 });
});

test('a fully-failed classification marks the digest failed and never advances the window', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (const i of [1, 2, 3]) {
		await seedComment(`c${i}`, 'UC1', `text ${i}`, `2026-01-0${i}T00:00:00.000Z`);
		fetchFailures[`text ${i}`] = 'boom';
	}
	const first = await generateFeedbackDigest('UC1', { force: true });
	expect(first.status).toBe('failed');
	const failed = await testDb().db.select().from(feedbackDigests).get();
	expect(failed?.status).toBe('failed');
	// The failed row does NOT anchor the window — fixing the outage and
	// re-running classifies the same comments and replaces the row.
	fetchFailures = {};
	for (const i of [1, 2, 3]) {
		RESPONSES[`text ${i}`] = { category: 'question', hasAbuse: false, claim: 'same theme' };
	}
	const second = await generateFeedbackDigest('UC1', { force: true });
	expect(second.status).toBe('complete');
	expect(await testDb().db.select().from(feedbackDigests).all()).toHaveLength(1);
	expect(await testDb().db.select().from(feedbackFindings).all()).toHaveLength(1);
});

test('timestamps with timezone offsets are windowed by instant, not text order', async () => {
	// publishedAt is stored verbatim — any parseable offset is legal in the
	// data model (youtube.ts validates with Date.parse only). The offset
	// comment below is 2026-01-04T19:30:00Z, so '2026-01-04T23:00:00.000Z' is
	// the true latest instant even though it sorts EARLIER as text. A text
	// compare anchors the window to the wrong string and permanently skips
	// comments whose instants fall between the two (codeant).
	await seedChannel('UC1', { feedbackEnabled: 1 });
	await seedComment('offset', 'UC1', 'offset comment', '2026-01-05T01:00:00+05:30'); // = 2026-01-04T19:30:00Z
	await seedComment('latest', 'UC1', 'latest comment', '2026-01-04T23:00:00.000Z');
	RESPONSES = {
		'offset comment': { category: 'question', hasAbuse: false, claim: 'a theme' },
		'latest comment': { category: 'question', hasAbuse: false, claim: 'a theme' }
	};

	const first = await generateFeedbackDigest('UC1', { force: true });
	expect(first).toMatchObject({ status: 'complete', commentsClassified: 2 });
	const digest = await testDb().db.select().from(feedbackDigests).get();
	expect(digest?.windowEnd).toBe('2026-01-04T23:00:00.000Z');

	// This comment's instant is after the stored windowEnd but its text sorts
	// BEFORE the offset string — a text boundary drops it forever.
	await seedComment('between', 'UC1', 'between comment', '2026-01-04T23:30:00.000Z');
	RESPONSES['between comment'] = { category: 'question', hasAbuse: false, claim: 'a theme' };
	const second = await generateFeedbackDigest('UC1', { force: true });
	expect(second).toMatchObject({ status: 'complete', commentsClassified: 1 });
});

test('the next window starts where the last complete digest ended', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (const i of [1, 2, 3]) {
		await seedComment(`old${i}`, 'UC1', `old q ${i}`, `2026-01-0${i}T00:00:00.000Z`);
		RESPONSES[`old q ${i}`] = { category: 'question', hasAbuse: false, claim: 'old theme' };
	}
	await generateFeedbackDigest('UC1', { force: true });
	// New comments after the window — only they get classified next.
	await seedComment('new1', 'UC1', 'new question a', '2026-01-10T00:00:00.000Z');
	RESPONSES['new question a'] = { category: 'question', hasAbuse: false, claim: 'new theme' };
	const second = await generateFeedbackDigest('UC1', { force: true });
	expect(second).toMatchObject({ status: 'complete', commentsClassified: 1 });
	const digests = await testDb().db.select().from(feedbackDigests).orderBy(feedbackDigests.windowStart).all();
	expect(digests).toHaveLength(2);
	expect(digests[1].windowStart).toBe(digests[0].windowEnd);
});

test('metered orgs pay one credit per attempted comment, inside the same transaction', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 10 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (const i of [1, 2, 3]) {
		await seedComment(`c${i}`, 'UC1', `text ${i}`, `2026-01-0${i}T00:00:00.000Z`);
	}
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result).toMatchObject({ status: 'complete', creditsUsed: 3 });
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.creditsRemaining).toBe(7);
	const ledger = await testDb().db.select().from(creditTransactions).all();
	expect(ledger).toHaveLength(3);
	expect(ledger.every((row) => row.refType === 'feedback')).toBe(true);
	// A re-run finds no unprocessed comments (the marker, not the window,
	// is the coverage record) — it is a no-op that touches nothing.
	const second = await generateFeedbackDigest('UC1', { force: true });
	expect(second.status).toBe('empty');
	const after = await testDb().db.select().from(creditTransactions).all();
	expect(after).toHaveLength(3);
	const orgAfter = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(orgAfter?.creditsRemaining).toBe(7);
});

test('a run interrupted after charging re-anchors instead of re-charging', async () => {
	// The charge commits in its own transaction BEFORE the provider calls
	// (codex). If the write tx never lands — crash, deadline — the anchors
	// persist and the retry classifies the same comments without paying again.
	await testDb().db.update(organizations).set({ creditsRemaining: 10 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (const i of [1, 2, 3]) {
		await seedComment(`c${i}`, 'UC1', `text ${i}`, `2026-01-0${i}T00:00:00.000Z`);
	}
	// Simulate the orphan anchors a crashed run would leave behind.
	for (const id of ['c1', 'c2']) {
		await testDb().db.insert(creditTransactions).values({
			orgId: 'org-1', delta: -1, reason: 'consume', refType: 'feedback', refId: id, balanceAfter: 9
		});
	}
	RESPONSES = Object.fromEntries([1, 2, 3].map((i) => [`text ${i}`, { category: 'question', hasAbuse: false, claim: 'theme' }]));
	const result = await generateFeedbackDigest('UC1', { force: true });
	// creditsUsed counts every comment the digest covered — the two orphan
	// anchors are spend the org already made FOR this batch (codex).
	expect(result).toMatchObject({ status: 'complete', commentsClassified: 3, creditsUsed: 3 });
	const ledger = await testDb().db.select().from(creditTransactions).all();
	expect(ledger).toHaveLength(3);
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.creditsRemaining).toBe(9);
});

test('a failed run still holds its charge anchors — the retry does not re-charge', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 10 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (const i of [1, 2, 3]) {
		await seedComment(`c${i}`, 'UC1', `text ${i}`, `2026-01-0${i}T00:00:00.000Z`);
		fetchFailures[`text ${i}`] = 'boom';
	}
	const first = await generateFeedbackDigest('UC1', { force: true });
	expect(first.status).toBe('failed');
	// The attempted classifications were real provider work — the charges
	// stand, and the failed digest row still records the outage.
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(3);
	fetchFailures = {};
	for (const i of [1, 2, 3]) {
		RESPONSES[`text ${i}`] = { category: 'question', hasAbuse: false, claim: 'theme' };
	}
	const second = await generateFeedbackDigest('UC1', { force: true });
	// The retry debits nothing new — the ledger stays at 3 — but the digest's
	// comments still cost the org 3 credits; reporting 0 would lie (codex).
	expect(second).toMatchObject({ status: 'complete', creditsUsed: 3 });
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(3);
});

test('a comment backfilled with an older publishedAt is still digested', async () => {
	// Analyze-history deliberately inserts old comments AFTER the window has
	// advanced — a publication-time cursor would never see them (codex).
	await seedChannel('UC1', { feedbackEnabled: 1 });
	await seedComment('new1', 'UC1', 'new question', '2026-02-01T00:00:00.000Z');
	RESPONSES['new question'] = { category: 'question', hasAbuse: false, claim: 'new theme' };
	expect((await generateFeedbackDigest('UC1', { force: true })).status).toBe('complete');

	await seedComment('old1', 'UC1', 'old question', '2020-01-01T00:00:00.000Z');
	RESPONSES['old question'] = { category: 'question', hasAbuse: false, claim: 'old theme' };
	const second = await generateFeedbackDigest('UC1', { force: true });
	expect(second).toMatchObject({ status: 'complete', commentsClassified: 1 });
});

test('a timestamp tie at the cap boundary does not drop the remainder', async () => {
	// 101 comments where the 100th and 101st share a publishedAt instant —
	// a window anchored on that instant would lose the tied row forever.
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (let i = 0; i < 101; i++) {
		const publishedAt = i >= 99 ? '2026-02-01T00:00:00.000Z' : new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
		await seedComment(`c${i}`, 'UC1', `t${i}`, publishedAt);
		RESPONSES[`t${i}`] = { category: 'question', hasAbuse: false, claim: `theme ${i}` };
	}
	const first = await generateFeedbackDigest('UC1', { force: true });
	expect(first).toMatchObject({ status: 'complete', commentsClassified: 100 });
	const second = await generateFeedbackDigest('UC1', { force: true });
	expect(second).toMatchObject({ status: 'complete', commentsClassified: 1 });
	const covered = await testDb().db.select().from(comments).where(isNull(comments.feedbackDigestedAt)).all();
	expect(covered).toHaveLength(0);
});

test('a capped batch keeps the channel due until the backlog drains', async () => {
	// Stamping the rotation on a capped batch would suppress the remaining
	// comments for a whole cadence period (codex) — the stamp only lands
	// once the page is not full.
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (let i = 0; i < 101; i++) {
		await seedComment(`c${i}`, 'UC1', `t${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
		RESPONSES[`t${i}`] = { category: 'question', hasAbuse: false, claim: `theme ${i}` };
	}
	const first = await generateFeedbackDigest('UC1', { force: true });
	expect(first).toMatchObject({ status: 'complete', commentsClassified: 100 });
	let ch = (await testDb().db.select().from(channels).get())!;
	expect(ch.feedbackLastDigestAt).toBeNull();
	expect(await digestDue(ch)).toBe(true);
	const second = await generateFeedbackDigest('UC1', { force: true });
	expect(second).toMatchObject({ status: 'complete', commentsClassified: 1 });
	ch = (await testDb().db.select().from(channels).get())!;
	expect(ch.feedbackLastDigestAt).not.toBeNull();
	expect(await digestDue(ch)).toBe(false);
});

test('a deadline already spent rolls the charge transaction back — no credits, no provider calls', async () => {
	// Cron hands the digest whatever budget the moderation page left — which
	// can be past the deadline. The charge tx must abort with NOTHING
	// committed: committing credits when every classifyFeedback would
	// reject on arrival debits the balance for work that never ran (codex).
	await testDb().db.update(organizations).set({ creditsRemaining: 10 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (const i of [1, 2, 3]) {
		await seedComment(`c${i}`, 'UC1', `text ${i}`, `2026-01-0${i}T00:00:00.000Z`);
	}
	const result = await generateFeedbackDigest('UC1', { force: true, deadline: Date.now() - 1 });
	expect(result).toMatchObject({ status: 'deferred', reason: 'deadline' });
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(0);
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.creditsRemaining).toBe(10);
	expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	// The comments stay unprocessed — the next tick retries them.
	expect(await testDb().db.select().from(comments).where(isNull(comments.feedbackDigestedAt)).all()).toHaveLength(3);
});

test('same-timestamp capped batches keep distinct digest rows — the window anchor never deletes a complete digest', async () => {
	// 201 comments sharing one publishedAt: batch 2 and batch 3 both land on
	// the descriptive window (T,T). The anchor exists to replace a FAILED or
	// DEFERRED leftover, never a completed digest — otherwise backlog
	// history silently loses an entire processed batch (codex).
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (let i = 0; i < 201; i++) {
		await seedComment(`c${i}`, 'UC1', `t${i}`, '2026-02-01T00:00:00.000Z');
		RESPONSES[`t${i}`] = { category: 'question', hasAbuse: false, claim: `theme ${i}` };
	}
	for (const expected of [100, 100, 1]) {
		const result = await generateFeedbackDigest('UC1', { force: true });
		expect(result).toMatchObject({ status: 'complete', commentsClassified: expected });
	}
	const digests = await testDb().db.select().from(feedbackDigests).orderBy(feedbackDigests.id).all();
	expect(digests).toHaveLength(3);
	expect(digests.every((d) => d.status === 'complete')).toBe(true);
	expect(digests.reduce((sum, d) => sum + d.commentsClassified, 0)).toBe(201);
});

test('out-of-credit metered orgs defer without spending — and the deferral is recorded for the page', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 2 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (const i of [1, 2, 3]) {
		await seedComment(`c${i}`, 'UC1', `text ${i}`, `2026-01-0${i}T00:00:00.000Z`);
	}
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result).toMatchObject({ status: 'deferred', reason: 'credits' });
	// A cron deferral that only logs leaves the owner staring at "No digest
	// yet" while every tick repeats it — the deferral is channel-visible
	// state, recorded as a row (codex).
	const digests = await testDb().db.select().from(feedbackDigests).all();
	expect(digests).toHaveLength(1);
	expect(digests[0]).toMatchObject({ status: 'deferred', error: 'credits' });
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(0);
	// Balance untouched — the deferral charged nothing.
	const org = await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get();
	expect(org?.creditsRemaining).toBe(2);
});

test('a complete run clears the deferred row — it describes channel state, not history', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 2 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (const i of [1, 2, 3]) {
		await seedComment(`c${i}`, 'UC1', `text ${i}`, `2026-01-0${i}T00:00:00.000Z`);
		RESPONSES[`text ${i}`] = { category: 'question', hasAbuse: false, claim: 'theme' };
	}
	expect((await generateFeedbackDigest('UC1', { force: true })).status).toBe('deferred');
	// The owner tops up; the next tick completes and the stale deferral
	// banner must not linger beside the real digest.
	await testDb().db.update(organizations).set({ creditsRemaining: 10 }).where(eq(organizations.id, 'org-1'));
	expect((await generateFeedbackDigest('UC1', { force: true })).status).toBe('complete');
	const digests = await testDb().db.select().from(feedbackDigests).all();
	expect(digests).toHaveLength(1);
	expect(digests[0].status).toBe('complete');
});

test('unmetered (lifetime) orgs run on their BYOK key without any credit writes', async () => {
	await testDb()
		.db.update(organizations)
		.set({ plan: 'lifetime', openaiKeyEnc: 'enc-org-key' })
		.where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (const i of [1, 2, 3]) {
		await seedComment(`c${i}`, 'UC1', `text ${i}`, `2026-01-0${i}T00:00:00.000Z`);
	}
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result.status).toBe('complete');
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(0);
	// The org's own key, not the deployment env key, went to OpenAI.
	const fetchMock = vi.mocked(fetch);
	const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
	expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer decrypted:enc-org-key' });
	expect(body).toBeTruthy();
});

test('a lifetime org with no BYOK key fails loudly — never silently unmetered on the env key', async () => {
	await testDb().db.update(organizations).set({ plan: 'lifetime' }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1 });
	await seedComment('c1', 'UC1', 'when is the next video', '2026-01-05T00:00:00.000Z');
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result).toMatchObject({ status: 'failed', reason: 'no-key' });
	const digest = await testDb().db.select().from(feedbackDigests).get();
	expect(digest?.status).toBe('failed');
	expect(digest?.error).toBe('scoring');
});

test('the enabled-category mask excludes findings but still pools them', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackCategories: 'question' });
	for (const i of [1, 2, 3]) {
		await seedComment(`c${i}`, 'UC1', `do a part two ${i}`, `2026-01-0${i}T00:00:00.000Z`);
		RESPONSES[`do a part two ${i}`] = { category: 'request', hasAbuse: false, claim: 'make a part two' };
	}
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result).toMatchObject({ status: 'complete', findings: 0, pooled: 3 });
});

test('a concealed-only evidence comment stores the placeholder', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1 });
	for (const i of [1, 2, 3]) {
		await seedComment(`c${i}`, 'UC1', `question ${i}`, `2026-01-0${i}T00:00:00.000Z`);
		RESPONSES[`question ${i}`] = { category: 'question', hasAbuse: false, claim: 'shared theme' };
	}
	// One supporter is pure abuse the lexicon can't pinpoint.
	await seedComment('evil', 'UC1', 'absolute noodle-tier effort buddy', '2026-01-04T00:00:00.000Z');
	RESPONSES['absolute noodle-tier effort buddy'] = { category: 'question', hasAbuse: true, claim: 'shared theme' };
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result.status).toBe('complete');
	const rows = await testDb().db.select().from(findingEvidence).all();
	const concealed = rows.find((r) => r.hasAbuse === 1)!;
	expect(concealed.sanitizedExcerpt).toBe(CONCEALED_MESSAGE);
});

test('historical batches deduplicate completed IDs before charging, advance only feedback state, and never create moderated comments', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 5 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', {
		feedbackEnabled: 1,
		feedbackCadence: 'manual',
		feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z',
		feedbackHistoryPageToken: 'page-1',
		cursor: '2026-01-01T00:00:00.000Z',
		nextPageToken: 'live-page',
		scanCursor: 'live-scan'
	});
	await seedComment('stored-done', 'UC1', 'already processed normal comment', '2024-01-01T00:00:00.000Z');
	await testDb().db.update(comments).set({ feedbackDigestedAt: '2025-01-01T00:00:00.000Z', status: 'held', decidedBy: 'human' }).where(eq(comments.id, 'stored-done'));
	await testDb().db.insert(feedbackHistoryComments).values({ id: 'history-done', channelId: 'UC1', text: 'already processed history', publishedAt: '2024-01-02T00:00:00.000Z' });
	const longText = 'ordinary feedback '.repeat(40);
	mocks.fetchNewComments.mockResolvedValue({
		comments: [
			{ id: 'new-history', text: longText, publishedAt: '2024-01-03T00:00:00.000Z' },
			{ id: 'stored-done', text: 'stored duplicate', publishedAt: '2024-01-01T00:00:00.000Z' },
			{ id: 'history-done', text: 'history duplicate', publishedAt: '2024-01-02T00:00:00.000Z' },
			{ id: 'new-history', text: 'duplicate response ID', publishedAt: '2024-01-03T00:00:00.000Z' }
		],
		nextPageToken: 'page-2',
		reachedCursor: false
	});

	const channel = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(await digestDue(channel)).toBe(true);
	const result = await generateFeedbackDigest('UC1');

	expect(result).toMatchObject({ status: 'complete', commentsClassified: 1, commentsFailed: 0, creditsUsed: 1, historyRemaining: true });
	expect(mocks.fetchNewComments).toHaveBeenCalledWith('UC1', 'access-token', '2025-01-01T00:00:00.000Z', {
		maxPages: 1, pageToken: 'page-1', deadline: undefined
	});
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(1);
	expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.creditsRemaining).toBe(4);
	const sources = await testDb().db.select().from(feedbackHistoryComments).where(eq(feedbackHistoryComments.channelId, 'UC1')).all();
	expect(sources).toHaveLength(2);
	expect(sources.find((row) => row.id === 'new-history')?.text).toBe(longText.slice(0, 500));
	const stored = (await testDb().db.select().from(comments).where(eq(comments.id, 'stored-done')).get())!;
	expect(stored).toMatchObject({ status: 'held', decidedBy: 'human', feedbackDigestedAt: '2025-01-01T00:00:00.000Z' });
	expect(await testDb().db.select().from(comments).where(eq(comments.channelId, 'UC1')).all()).toHaveLength(1);
	const updatedChannel = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(updatedChannel).toMatchObject({
		feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-2',
		cursor: '2026-01-01T00:00:00.000Z', nextPageToken: 'live-page', scanCursor: 'live-scan'
	});
});

test('two historical pages produce distinct digests and advance only the feedback checkpoint', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 10 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', {
		feedbackEnabled: 1,
		feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z',
		feedbackHistoryPageToken: 'page-1',
		cursor: '2026-01-01T00:00:00.000Z',
		nextPageToken: 'live-page',
		scanCursor: 'live-scan'
	});
	mocks.fetchNewComments
		.mockResolvedValueOnce({ comments: [{ id: 'history-one', text: 'one historical comment', publishedAt: '2024-01-01T00:00:00.000Z' }], nextPageToken: 'page-2', reachedCursor: false })
		.mockResolvedValueOnce({ comments: [{ id: 'history-two', text: 'another historical comment', publishedAt: '2024-01-02T00:00:00.000Z' }], nextPageToken: null, reachedCursor: true });

	const first = await generateFeedbackDigest('UC1');
	const second = await generateFeedbackDigest('UC1');

	expect(first).toMatchObject({ status: 'complete', commentsClassified: 1, creditsUsed: 1, historyRemaining: true });
	expect(second).toMatchObject({ status: 'complete', commentsClassified: 1, creditsUsed: 1, historyRemaining: false });
	expect(mocks.fetchNewComments.mock.calls.map((call) => call[3]?.pageToken)).toEqual(['page-1', 'page-2']);
	expect((await testDb().db.select().from(feedbackDigests).orderBy(feedbackDigests.id).all()).map((digest) => digest.windowEnd)).toEqual([
		'2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z'
	]);
	expect(await testDb().db.select().from(feedbackHistoryComments).where(eq(feedbackHistoryComments.channelId, 'UC1')).all()).toHaveLength(2);
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(2);
	expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.creditsRemaining).toBe(8);
	expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())).toMatchObject({
		feedbackHistoryBoundary: null, feedbackHistoryPageToken: null,
		cursor: '2026-01-01T00:00:00.000Z', nextPageToken: 'live-page', scanCursor: 'live-scan'
	});
});

test('a fully failed historical batch retries without debiting its persisted charges twice', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 10 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-1' });
	mocks.fetchNewComments.mockResolvedValue({
		comments: [
			{ id: 'fail-one', text: 'broken one', publishedAt: '2024-01-01T00:00:00.000Z' },
			{ id: 'fail-two', text: 'broken two', publishedAt: '2024-01-02T00:00:00.000Z' }
		],
		nextPageToken: null,
		reachedCursor: true
	});
	fetchFailures = { 'broken one': 'temporary failure', 'broken two': 'temporary failure' };

	const first = await generateFeedbackDigest('UC1');

	expect(first).toMatchObject({ status: 'failed', historyRemaining: true });
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(2);
	expect(await testDb().db.select().from(feedbackHistoryComments).all()).toHaveLength(0);
	expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())?.feedbackHistoryBoundary).toBe('2025-01-01T00:00:00.000Z');
	fetchFailures = {};

	const retry = await generateFeedbackDigest('UC1');

	expect(retry).toMatchObject({ status: 'complete', commentsClassified: 2, creditsUsed: 2, historyRemaining: false });
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(2);
	expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.creditsRemaining).toBe(8);
	expect(await testDb().db.select().from(feedbackHistoryComments).all()).toHaveLength(2);
	expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())?.feedbackHistoryBoundary).toBeNull();
});

test('history write headroom deferral preserves the checkpoint and writes no completed sources', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 10 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-1' });
	mocks.fetchNewComments.mockResolvedValue({ comments: [{ id: 'history-one', text: 'one historical comment', publishedAt: '2024-01-01T00:00:00.000Z' }], nextPageToken: null, reachedCursor: true });

	const result = await generateFeedbackDigest('UC1', { deadline: Date.now() + 2_000 });

	expect(result).toMatchObject({ status: 'deferred', reason: 'deadline', historyRemaining: true });
	expect(await testDb().db.select().from(feedbackHistoryComments).all()).toHaveLength(0);
	expect(await testDb().db.select().from(feedbackDigests).all()).toMatchObject([{ status: 'deferred', error: 'deadline' }]);
	expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())).toMatchObject({ feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-1' });
});

test.each(['reassigned', 'deleted'] as const)('a channel %s during classification cannot retain history writes', async (race) => {
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z' });
	mocks.fetchNewComments.mockResolvedValue({ comments: [{ id: 'history-one', text: 'one historical comment', publishedAt: '2024-01-01T00:00:00.000Z' }], nextPageToken: null, reachedCursor: true });
	beforeClassify = async () => {
		if (race === 'reassigned') await testDb().db.update(channels).set({ orgId: 'org-other' }).where(eq(channels.id, 'UC1'));
		else await testDb().db.delete(channels).where(eq(channels.id, 'UC1'));
	};
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		const result = await generateFeedbackDigest('UC1');
		expect(result).toMatchObject({ status: 'failed', reason: 'error', historyRemaining: true });
		expect(await testDb().db.select().from(feedbackDigests).where(eq(feedbackDigests.channelId, 'UC1')).all()).toHaveLength(0);
		expect(await testDb().db.select().from(feedbackHistoryComments).all()).toHaveLength(0);
		if (race === 'reassigned') expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())?.orgId).toBe('org-other');
		else expect(await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get()).toBeUndefined();
	} finally {
		errorSpy.mockRestore();
	}
});

test('a history source inserted later by moderation is skipped by the ordinary stored digest', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 10 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z' });
	mocks.fetchNewComments.mockResolvedValue({ comments: [{ id: 'history-one', text: 'one historical comment', publishedAt: '2024-01-01T00:00:00.000Z' }], nextPageToken: null, reachedCursor: true });
	await generateFeedbackDigest('UC1');
	await seedComment('history-one', 'UC1', 'one historical comment', '2024-01-01T00:00:00.000Z');

	const normal = await generateFeedbackDigest('UC1', { force: true });

	expect(normal).toEqual({ status: 'empty' });
	expect(await testDb().db.select().from(feedbackDigests).all()).toHaveLength(1);
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(1);
	expect((await testDb().db.select().from(comments).where(eq(comments.id, 'history-one')).get())?.status).toBe('approved');
});

test('historical batches on lifetime plans use the stored BYOK key and charge no credits', async () => {
	await testDb().db.update(organizations).set({ plan: 'lifetime', openaiKeyEnc: 'enc-org-key', creditsRemaining: 0 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z' });
	mocks.fetchNewComments.mockResolvedValue({ comments: [{ id: 'history-one', text: 'one historical comment', publishedAt: '2024-01-01T00:00:00.000Z' }], nextPageToken: null, reachedCursor: true });

	const result = await generateFeedbackDigest('UC1');

	expect(result).toMatchObject({ status: 'complete', creditsUsed: 0, historyRemaining: false });
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(0);
	expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.creditsRemaining).toBe(0);
	expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer decrypted:enc-org-key' });
});

test('a successful empty history page clears transient failures but retains completed digest history', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-1' });
	await testDb().db.insert(feedbackDigests).values({
		channelId: 'UC1', windowStart: '1970-01-01T00:00:00.000Z', windowEnd: '2024-01-01T00:00:00.000Z', status: 'complete', commentsClassified: 1
	});
	await seedComment('done', 'UC1', 'already digested', '2024-01-01T00:00:00.000Z');
	await testDb().db.update(comments).set({ feedbackDigestedAt: '2025-01-01T00:00:00.000Z' }).where(eq(comments.id, 'done'));
	mocks.fetchNewComments.mockRejectedValueOnce(new Error('temporary history fetch failure'));

	const failed = await generateFeedbackDigest('UC1');
	expect(failed).toMatchObject({ status: 'failed', reason: 'history-fetch' });
	expect((await testDb().db.select().from(feedbackDigests).all()).map((digest) => digest.status)).toContain('failed');
	mocks.fetchNewComments.mockResolvedValue({ comments: [{ id: 'done', text: 'already digested', publishedAt: '2024-01-01T00:00:00.000Z' }], nextPageToken: null, reachedCursor: true });

	const result = await generateFeedbackDigest('UC1');

	expect(result).toEqual({ status: 'empty', historyRemaining: false });
	expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())).toMatchObject({ feedbackHistoryBoundary: null, feedbackHistoryPageToken: null });
	expect((await testDb().db.select().from(feedbackDigests).all()).map((digest) => digest.status)).toEqual(['complete']);
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(0);
});

test('a historical YouTube failure is logged server-side, sanitized to the page, and leaves its checkpoint in place', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-1' });
	mocks.fetchNewComments.mockRejectedValue(new Error('private provider response token-123'));
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		const result = await generateFeedbackDigest('UC1');

		expect(result).toMatchObject({ status: 'failed', reason: 'history-fetch', historyRemaining: true });
		expect(JSON.stringify(result)).not.toContain('token-123');
		expect(errorSpy).toHaveBeenCalledWith('feedback history page fetch failed for channel:', 'UC1', expect.any(Error));
		expect((await testDb().db.select().from(feedbackDigests).get())).toMatchObject({ windowStart: '2025-01-01T00:00:00.000Z', status: 'failed', error: 'history-fetch' });
		expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())).toMatchObject({ feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-1' });
	} finally {
		errorSpy.mockRestore();
	}
});

test('repeated history-fetch failures keep one transient row at a stable window', async () => {
	// The failure window used to end at a fresh nowIso every attempt, so each
	// retry wrote a NEW transient row beside the old one and the history
	// accumulated forever (codex+cubic). Retries must update the same row.
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-1' });
	mocks.fetchNewComments.mockRejectedValue(new Error('youtube down'));
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		expect((await generateFeedbackDigest('UC1')).status).toBe('failed');
		const firstRow = await testDb().db.select().from(feedbackDigests).get();
		expect(firstRow).toMatchObject({ status: 'failed', error: 'history-fetch' });

		expect((await generateFeedbackDigest('UC1')).status).toBe('failed');
		expect((await generateFeedbackDigest('UC1')).status).toBe('failed');

		const rows = await testDb().db.select().from(feedbackDigests).all();
		expect(rows).toHaveLength(1);
		expect({ windowStart: rows[0].windowStart, windowEnd: rows[0].windowEnd }).toEqual({
			windowStart: firstRow?.windowStart,
			windowEnd: firstRow?.windowEnd
		});
	} finally {
		errorSpy.mockRestore();
	}
});

test('a stolen history lease rolls back the digest, source rows, and checkpoint write', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', leaseExpiresAt: '2099-01-01T00:00:00.000Z' });
	mocks.fetchNewComments.mockResolvedValue({ comments: [{ id: 'history-1', text: 'one history comment', publishedAt: '2024-01-01T00:00:00.000Z' }], nextPageToken: null, reachedCursor: true });
	beforeClassify = async () => {
		await testDb().db.update(channels).set({ leaseExpiresAt: '2100-01-01T00:00:00.000Z' }).where(eq(channels.id, 'UC1'));
	};
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

	try {
		const result = await generateFeedbackDigest('UC1');

		expect(result).toMatchObject({ status: 'failed', reason: 'error', historyRemaining: true });
		expect(await testDb().db.select().from(feedbackDigests).all()).toHaveLength(0);
		expect(await testDb().db.select().from(feedbackHistoryComments).all()).toHaveLength(0);
		expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())).toMatchObject({ feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', leaseExpiresAt: '2100-01-01T00:00:00.000Z' });
	} finally {
		errorSpy.mockRestore();
	}
});

test('historical partial classification failures remain counted, charged once, and recorded as completed sources', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 10 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z' });
	mocks.fetchNewComments.mockResolvedValue({
		comments: [
			{ id: 'failed-history', text: 'broken history item', publishedAt: '2024-01-01T00:00:00.000Z' },
			{ id: 'none-history', text: 'none history item', publishedAt: '2024-01-02T00:00:00.000Z' }
		],
		nextPageToken: null,
		reachedCursor: true
	});
	fetchFailures = { 'broken history item': 'provider error' };

	const result = await generateFeedbackDigest('UC1');

	expect(result).toMatchObject({ status: 'complete', commentsClassified: 1, commentsFailed: 1, creditsUsed: 2, historyRemaining: false });
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(2);
	expect(await testDb().db.select().from(feedbackHistoryComments).where(eq(feedbackHistoryComments.channelId, 'UC1')).all()).toHaveLength(2);
	expect((await testDb().db.select().from(feedbackDigests).get())).toMatchObject({ commentsFailed: 1, creditsUsed: 2 });
	expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())).toMatchObject({ feedbackHistoryBoundary: null, feedbackHistoryPageToken: null });
});

test('a historical credit shortfall defers the whole page before classification or source writes', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 1 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-1' });
	mocks.fetchNewComments.mockResolvedValue({
		comments: [
			{ id: 'h1', text: 'first history source', publishedAt: '2024-01-01T00:00:00.000Z' },
			{ id: 'h2', text: 'second history source', publishedAt: '2024-01-02T00:00:00.000Z' }
		],
		nextPageToken: null,
		reachedCursor: true
	});

	const result = await generateFeedbackDigest('UC1');

	expect(result).toMatchObject({ status: 'deferred', reason: 'credits', historyRemaining: true });
	expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(0);
	expect(await testDb().db.select().from(feedbackDigests).all()).toHaveLength(1);
	expect(await testDb().db.select().from(feedbackHistoryComments).all()).toHaveLength(0);
	expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.creditsRemaining).toBe(1);
	expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())).toMatchObject({ feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z', feedbackHistoryPageToken: 'page-1' });
});

test('feedback dry-run handles an empty first page without writes or credits', async () => {
	await seedChannel('UC1');
	mocks.fetchNewComments.mockResolvedValue({ comments: [], nextPageToken: null, reachedCursor: true });

	const preview = await previewFeedbackDigest('UC1', { boundary: '2025-01-01T00:00:00.000Z' });

	expect(preview).toEqual({ commentsClassified: 0, commentsFailed: 0, pooled: 0, hasMore: false, findings: [] });
	expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	expect(await testDb().db.select().from(feedbackDigests).all()).toHaveLength(0);
	expect(await testDb().db.select().from(feedbackHistoryComments).all()).toHaveLength(0);
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(0);
});

test('feedback dry-run builds grouped sanitized findings without writing or charging', async () => {
	await testDb().db.update(organizations).set({ creditsRemaining: 8 }).where(eq(organizations.id, 'org-1'));
	await seedChannel('UC1', { feedbackThreshold: 3, cursor: '2026-01-01T00:00:00.000Z' });
	const texts = ['when is the next stream?', 'when does the next stream start?', 'when will the next stream happen?'];
	mocks.fetchNewComments.mockResolvedValue({
		comments: texts.map((text, index) => ({ id: `preview-${index}`, text, publishedAt: `2026-01-0${index + 1}T00:00:00.000Z` })),
		nextPageToken: 'preview-page-2',
		reachedCursor: false
	});
	RESPONSES = Object.fromEntries(texts.map((text) => [text, { category: 'question', hasAbuse: false, claim: 'when is the next stream' }]));
	RESPONSES[texts[2]] = { category: 'question', hasAbuse: true, claim: 'when is the next stream' };

	const preview = await previewFeedbackDigest('UC1', { boundary: '2025-12-01T00:00:00.000Z', deadline: Date.now() + 15_000 });

	expect(preview).toMatchObject({ commentsClassified: 3, commentsFailed: 0, pooled: 0, hasMore: true });
	expect(preview.findings).toHaveLength(1);
	expect(preview.findings[0]).toMatchObject({ category: 'question', supporterCount: 3 });
	expect(JSON.stringify(preview)).not.toContain(texts[2]);
	expect(preview.findings[0].evidence.some((item) => item.hasAbuse === 1 && item.sanitizedExcerpt === CONCEALED_MESSAGE)).toBe(true);
	expect(await testDb().db.select().from(feedbackDigests).all()).toHaveLength(0);
	expect(await testDb().db.select().from(feedbackHistoryComments).all()).toHaveLength(0);
	expect(await testDb().db.select().from(comments).all()).toHaveLength(0);
	expect(await testDb().db.select().from(creditTransactions).all()).toHaveLength(0);
	expect((await testDb().db.select().from(organizations).where(eq(organizations.id, 'org-1')).get())?.creditsRemaining).toBe(8);
	expect((await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())).toMatchObject({ cursor: '2026-01-01T00:00:00.000Z', feedbackHistoryBoundary: null });
});

test('a feedback preview aborts when its claimed row was swapped mid-claim', async () => {
	// The claim's fingerprint — org, connector ciphertext, lease — must match
	// the live row: a delete/reconnect reuses the channel id with a fresh
	// grant, and running the preview against it would spend the wrong org's
	// YouTube quota and expose its comments to the claimant (cubic+codeant).
	await seedChannel('UC1', { feedbackEnabled: 1, leaseExpiresAt: '2099-01-01T00:00:00.000Z' });
	const claim = { orgId: 'org-1', refreshTokenEnc: 'enc', leaseExpiresAt: '2099-01-01T00:00:00.000Z' };
	await testDb().db.delete(channels).where(eq(channels.id, 'UC1'));
	await seedChannel('UC1', { feedbackEnabled: 1, refreshTokenEnc: 'enc-reconnected' });

	await expect(
		previewFeedbackDigest('UC1', { boundary: '2025-01-01T00:00:00.000Z', claim })
	).rejects.toThrow('changed under the dry-run claim');
	expect(mocks.fetchNewComments).not.toHaveBeenCalled();
});

// ---- cadence + rotation ----

test('digestDue: an active history scan bypasses manual and recent weekly cadence', async () => {
	await seedChannel('UC1', { feedbackCadence: 'manual', feedbackHistoryBoundary: '2025-01-01T00:00:00.000Z' });
	let channel = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(await digestDue(channel)).toBe(true);
	await testDb().db.update(channels).set({ feedbackCadence: 'weekly', feedbackLastDigestAt: new Date().toISOString() }).where(eq(channels.id, 'UC1'));
	channel = (await testDb().db.select().from(channels).where(eq(channels.id, 'UC1')).get())!;
	expect(await digestDue(channel)).toBe(true);
});

test('digestDue: weekly due when never generated, not due inside 7 days', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1 });
	expect(await digestDue((await testDb().db.select().from(channels).get())!)).toBe(true);
	await testDb().db.update(channels).set({ feedbackLastDigestAt: new Date().toISOString() }).where(eq(channels.id, 'UC1'));
	expect(await digestDue((await testDb().db.select().from(channels).get())!)).toBe(false);
});

test('digestDue: manual cadence never auto-due', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackCadence: 'manual' });
	const ch = (await testDb().db.select().from(channels).get())!;
	expect(await digestDue(ch)).toBe(false);
});

test('digestDue: per_100 needs ≥100 comments past the last window', async () => {
	await seedChannel('UC1', { feedbackEnabled: 1, feedbackCadence: 'per_100' });
	const ch = (await testDb().db.select().from(channels).get())!;
	expect(await digestDue(ch)).toBe(false);
	for (let i = 0; i < 100; i++) {
		await seedComment(`c${i}`, 'UC1', `t${i}`, new Date(Date.UTC(2026, 0, 5, 0, 0, i)).toISOString());
	}
	const after = (await testDb().db.select().from(channels).get())!;
	expect(await digestDue(after)).toBe(true);
});

