// Property tests for runChannel (pipeline.ts) against the REAL in-memory test
// database (testdb.ts mocks $lib/server/db). Unlike pipeline.test.ts (hoisted
// fake db), only the network/env seams are mocked: YouTube API calls
// ($lib/server/youtube), the AI scorers ($lib/server/moderation.scoreComment,
// $lib/server/tone), BYOK key resolution ($lib/server/openaiKey), token
// decryption ($lib/server/crypto — generated rows carry no real ciphertext),
// and $env/dynamic/private (DRY_RUN). Everything else is real: drizzle writes,
// dedupe, rule preparation (recheck unmocked — no rules are seeded here), the
// deadline helpers ($lib/server/http), and serializeScores (pure).

import fc from 'fast-check';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = await vi.hoisted(async () => (await import('./pbt-support')).createPipelineMocks());

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/crypto', () => ({ decrypt: mocks.decrypt }));
vi.mock('$lib/server/moderation', async (importOriginal) =>
	(await import('./pbt-support')).moderationMockModule(importOriginal, mocks)
);
vi.mock('$lib/server/tone', () => ({ scoreTone: mocks.scoreTone }));
vi.mock('$lib/server/openaiKey', () => ({ resolveOpenAiKey: mocks.resolveOpenAiKey }));
vi.mock('$lib/server/youtube', async () => (await import('./pbt-support')).youtubeMockModule(mocks));

import { setupTestDb, testDb, wipeTables } from './testdb';
import { auditLog, channels, comments, creditTransactions, moderationActions, organizations } from './db/schema';
import { runChannel } from './pipeline';
import type { CommentPage } from './youtube';
import { channelRowArb } from './testarbitraries';
import {
	by,
	commentSetArb,
	deterministicScore,
	PBT_WIPE,
	scoreDeterministically,
	scoresFor,
	seedChannel
} from './pbt-support';

setupTestDb(PBT_WIPE);

beforeEach(() => {
	vi.clearAllMocks();
});

/**
 * Ingest input: a channel plus a comment set, plus a duplicate tail —
 * commentThreads pagination can repeat an item across page boundaries, so the
 * page re-presents a generated subset of its own comments (same id AND text).
 */
const ingestRunArb = fc.tuple(channelRowArb, commentSetArb).chain(([channel, set]) =>
	fc.record({
		channel: fc.constant(channel),
		set: fc.constant(set),
		duplicates: fc.subarray(set)
	})
);

/** Whole-database dump of everything a run may durably change. */
async function snapshot() {
	const db = testDb().db;
	return {
		comments: by(await db.select().from(comments).all(), (row) => row.id),
		moderationActions: by(await db.select().from(moderationActions).all(), (row) => row.commentId),
		auditLog: by(await db.select().from(auditLog).all(), (row) => row.id),
		channels: by(await db.select().from(channels).all(), (row) => row.id),
		creditTransactions: by(await db.select().from(creditTransactions).all(), (row) => row.id),
		organizations: by(await db.select().from(organizations).all(), (row) => row.id)
	};
}

test('I4 idempotent ingest: re-presenting the same generated page leaves the database byte-identical', async () => {
	// Property audit: dropping the stored-ids dedupe (existingIds) makes run 2
	// re-insert every comment — the staging transaction hits the comments.id
	// PRIMARY KEY and the run throws (red). Dropping the within-batch seen-set
	// does the same via the generated duplicate tail (red). Persisting author
	// PII, storing untruncated text, or rejecting over-limit comments breaks the
	// per-row storage oracle. Any second-run write (cursor churn, duplicate
	// audit/action rows) breaks the snap2 ≡ snap1 whole-database comparison.
	await fc.assert(
		fc.asyncProperty(ingestRunArb, async (run) => {
			await wipeTables(PBT_WIPE); // fresh state per run, not per test
			await seedChannel(run.channel);
			const pageComments = [...run.set, ...run.duplicates];
			const page: CommentPage = { comments: pageComments, nextPageToken: null, reachedCursor: true };
			mocks.fetchNewComments.mockResolvedValue(page);
			mocks.scoreComment.mockImplementation(scoreDeterministically);

			const first = await runChannel(run.channel.id);
			const snap1 = await snapshot();
			const second = await runChannel(run.channel.id); // identical page re-presented
			const snap2 = await snapshot();

			expect(first.fetched).toBe(pageComments.length);
			expect(second.fetched).toBe(pageComments.length);
			// Dedupe by comments.id must make the second pass a complete no-op.
			expect(snap2).toEqual(snap1);

			// Storage contract oracle (folded in): over-limit text is truncated,
			// never rejected; author PII is processed-and-discarded, never stored.
			expect(snap1.comments).toHaveLength(run.set.length);
			const sourceById = new Map(run.set.map((comment) => [comment.id, comment]));
			for (const row of snap1.comments) {
				const source = sourceById.get(row.id);
				if (!source) throw new Error(`stored comment ${row.id} was not in the generated set`);
				expect(row.text).toBe(source.text.slice(0, 500));
				expect(row.text.length).toBeLessThanOrEqual(500);
				expect(row.authorName).toBeNull();
				expect(row.authorChannelId).toBeNull();
				expect(row.publishedAt).toBe(source.publishedAt);
				expect(row.channelId).toBe(run.channel.id);
			}
		})
	);
});

/** I11 input: a comment set plus a per-comment failure mask and a failure message. */
const failureRunArb = fc.tuple(channelRowArb, commentSetArb).chain(([channel, set]) =>
	fc.record({
		channel: fc.constant(channel),
		set: fc.constant(set),
		mask: fc.array(fc.boolean(), { minLength: set.length, maxLength: set.length }),
		errorMessage: fc.string({ minLength: 1, maxLength: 80 })
	})
);

test('I11: generated scoring failures land in the human queue while scored comments are enforced', async () => {
	// Property audit: letting a scoring throw escape aiDecision aborts the run —
	// the awaited runChannel goes red. Auto-approving or auto-rejecting a failed
	// comment flips its status/decidedBy assertions; persisting an aiScore or a
	// matchedRuleId for a failure, or writing author PII anywhere, breaks the
	// null assertions. Scored omni comments sweep every band — delete at
	// 0.76–0.94, ban at ≥0.95 — while the always-flagged tone pass proves the
	// tone signal only ever holds; failed comments are held for review on
	// YouTube — still enforced, but with the 'hold' action — and the
	// moderation_actions oracle catches either side going missing or swapping
	// actions. Miscounting the queue breaks result.queued.
	await fc.assert(
		fc.asyncProperty(failureRunArb, async (run) => {
			await wipeTables(PBT_WIPE);
			await seedChannel(run.channel, 2); // tone level 2: the tone pass runs
			const page: CommentPage = { comments: run.set, nextPageToken: null, reachedCursor: true };
			mocks.fetchNewComments.mockResolvedValue(page);
			// The scorer sees only text, so the generated per-comment mask lands on
			// the comment's text: comments sharing a masked text fail together, and
			// the expectations below use the same text-keyed predicate.
			const failedTexts = new Set(run.set.filter((_, index) => run.mask[index]).map((comment) => comment.text));
			mocks.scoreComment.mockImplementation(async (text: string) => {
				if (failedTexts.has(text)) throw new Error(run.errorMessage);
				const score = deterministicScore(text);
				return { score, scores: scoresFor(score) };
			});
			// The tone pass always flags — its score lands in [0.76, 1.00], above
			// any sub-flag omni score — so every low-omni scored comment exercises
			// the tone-decides path, which must only ever produce 'hold'.
			mocks.scoreTone.mockImplementation(async (text: string) => ({
				score: Math.round((0.76 + deterministicScore(text) * 0.24) * 100) / 100
			}));

			// I11: a scoring failure never aborts the batch.
			const result = await runChannel(run.channel.id);

			const db = testDb().db;
			const stored = await db.select().from(comments).all();
			const actions = await db.select().from(moderationActions).all();
			const audits = await db.select().from(auditLog).all();
			expect(result.fetched).toBe(run.set.length);
			expect(stored).toHaveLength(run.set.length);

			let expectedQueued = 0;
			for (const comment of run.set) {
				const row = stored.find((candidate) => candidate.id === comment.id);
				if (!row) throw new Error(`comment ${comment.id} was not stored`);
				expect(row.authorName).toBeNull(); // deprecated author PII: never written
				expect(row.authorChannelId).toBeNull();
				expect(row.text.length).toBeLessThanOrEqual(500);
				if (failedTexts.has(comment.text)) {
					expectedQueued += 1;
					// Human review queue: never auto-approved, never auto-rejected.
					expect(row.status).toBe('pending');
					expect(row.decidedBy).toBe('none');
					expect(row.aiScore).toBeNull();
					expect(row.matchedRuleId).toBeNull();
				} else {
					const omni = deterministicScore(comment.text);
					// Omni flags: delete at 0.76–0.94, ban at ≥0.95. Below the flag
					// bands the always-flagged tone pass decides — and the tone
					// signal only ever holds, never deletes or bans.
					expect(row.status).toBe(omni >= 0.95 ? 'rejected' : omni >= 0.76 ? 'deleted' : 'held');
					expect(row.decidedBy).toBe('ai');
				}
			}
			expect(result.queued).toBe(expectedQueued);
			// Every comment carries a remote action: the omni-flagged ones are
			// deleted or banned per band, tone-flagged and queued (failed) ones
			// are held for review so they are genuinely non-public while they
			// wait for a human or sit in the audit log (MOD-5).
			const textById = new Map(run.set.map((comment) => [comment.id, comment.text]));
			expect(actions).toHaveLength(run.set.length);
			for (const action of actions) {
				// Every staged action must belong to a generated comment — a
				// foreign commentId must fail loudly here, not silently
				// resolve to '' (score 0 → 'hold') and mask a wrong action.
				expect(textById.has(action.commentId)).toBe(true);
				const text = textById.get(action.commentId) ?? '';
				const omni = deterministicScore(text);
				expect(action.action).toBe(
					failedTexts.has(text) || omni < 0.76 ? 'hold' : omni >= 0.95 ? 'ban' : 'delete'
				);
				expect(action.state).toBe('completed');
			}
			expect(audits.filter((row) => row.action === 'queue')).toHaveLength(expectedQueued);
		})
	);
});
