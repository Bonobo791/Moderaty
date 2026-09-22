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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { beforeEach, expect, test, vi } from 'vitest';
import { eq, isNull } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	env: { OPENAI_API_KEY: 'test-openai-key', DRY_RUN: 'false' } as Record<string, string | undefined>,
	decrypt: vi.fn((enc: string) => `decrypted:${enc}`)
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/crypto', () => ({ decrypt: mocks.decrypt }));

import { setupTestDb, testDb } from '$lib/server/testdb';
import { channels, comments, creditTransactions, feedbackDigests, feedbackFindings, findingEvidence, organizations } from '$lib/server/db/schema';
import { digestDue, generateFeedbackDigest } from './feedbackDigest';
import { CONCEALED_MESSAGE } from './feedbackSanitize';

setupTestDb(['finding_evidence', 'feedback_findings', 'feedback_digests', 'comments', 'channels', 'organizations', 'credit_transactions']);

// fetch mock: classify each comment from its text embedded in the prompt.
// Per-test RESPONSES maps comment-text → classification JSON; anything
// unmapped gets a 'none' verdict.
let RESPONSES: Record<string, { category: string; hasAbuse: boolean; claim: string }> = {};
let fetchFailures: Record<string, string> = {};

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
	mocks.env.DRY_RUN = 'false';
	vi.clearAllMocks();
	installFetch();
	// Every seeded channel attaches to org-1 — a bare 'free' org with a NULL
	// balance is unmetered (no purchases), so plain tests run charge-free.
	await seedOrg('org-1');
});

test('disabled channel skips without writing anything', async () => {
	await seedChannel('UC1', { feedbackEnabled: 0 });
	await seedComment('c1', 'UC1', 'when is the next video', '2026-01-05T00:00:00.000Z');
	const result = await generateFeedbackDigest('UC1', { force: true });
	expect(result.status).toBe('skipped');
	expect(await testDb().db.select().from(feedbackDigests).all()).toHaveLength(0);
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
	expect(result).toMatchObject({ status: 'complete', commentsClassified: 3, creditsUsed: 1 });
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
	expect(second).toMatchObject({ status: 'complete', creditsUsed: 0 });
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

// ---- cadence + rotation ----

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

