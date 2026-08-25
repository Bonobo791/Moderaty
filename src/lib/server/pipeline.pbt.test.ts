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

const mocks = vi.hoisted(() => ({
	// FC_NUM_RUNS rides through the env mock so testarbitraries.ts keeps
	// honoring the burn-in knob (it reads $env/dynamic/private at import time).
	env: { DRY_RUN: 'false', FC_NUM_RUNS: process.env.FC_NUM_RUNS } as Record<string, string | undefined>,
	decrypt: vi.fn(() => 'refresh-token'),
	refreshAccessToken: vi.fn(async () => 'access-token'),
	fetchNewComments: vi.fn(),
	fetchVideoMetadata: vi.fn(async () => new Map()),
	getCommentModerationStatus: vi.fn(async () => null),
	setModerationStatus: vi.fn(async () => {}),
	deleteComment: vi.fn(async () => {}),
	scoreComment: vi.fn(),
	scoreTone: vi.fn(),
	resolveOpenAiKey: vi.fn(async () => 'test-openai-key')
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/crypto', () => ({ decrypt: mocks.decrypt }));
vi.mock('$lib/server/moderation', async (importOriginal) => ({
	// serializeScores stays real (pure JSON); only the network scorer is mocked.
	...(await importOriginal<typeof import('$lib/server/moderation')>()),
	scoreComment: mocks.scoreComment
}));
vi.mock('$lib/server/tone', () => ({ scoreTone: mocks.scoreTone }));
vi.mock('$lib/server/openaiKey', () => ({ resolveOpenAiKey: mocks.resolveOpenAiKey }));
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: mocks.refreshAccessToken,
	fetchNewComments: mocks.fetchNewComments,
	fetchVideoMetadata: mocks.fetchVideoMetadata,
	getCommentModerationStatus: mocks.getCommentModerationStatus,
	setModerationStatus: mocks.setModerationStatus,
	deleteComment: mocks.deleteComment
}));

import { setupTestDb, testDb, wipeTables } from './testdb';
import { auditLog, channels, comments, creditTransactions, moderationActions, organizations } from './db/schema';
import { runChannel } from './pipeline';
import type { ToxicityScores } from './moderation';
import type { CommentPage, NewComment } from './youtube';
import {
	channelIdArb,
	channelRowArb,
	commentTextArb,
	idArb,
	isoTimestampArb,
	overLimitTextArb,
	type ChannelRow
} from './testarbitraries';

const WIPE = ['moderation_actions', 'comments', 'audit_log', 'rules', 'channels', 'organizations', 'credit_transactions'];

setupTestDb(WIPE);

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Generated input: NewComment-shaped data (the youtube.ts parser's OUTPUT —
// item-level malformed fuzz lives at the parser level, testarbitraries.test.ts)
// ---------------------------------------------------------------------------

/** A NewComment with storage-contract-hostile text (≤500 and 501–600 chars mixed). */
const newCommentArb: fc.Arbitrary<NewComment> = fc.record({
	id: idArb,
	threadId: idArb,
	videoId: fc.option(idArb, { nil: null }),
	authorChannelId: channelIdArb,
	authorName: fc.string({ maxLength: 40 }),
	text: fc.oneof(commentTextArb, overLimitTextArb),
	publishedAt: isoTimestampArb
});

/** 0–20 comments, unique ids by construction (cross-page duplicates are added on top). */
const commentSetArb = fc.uniqueArray(newCommentArb, {
	minLength: 0,
	maxLength: 20,
	selector: (comment) => comment.id
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

/**
 * Deterministic scorer: a pure hash of the comment text into [0, 0.99], so the
 * same text always decides identically across runs (idempotency needs that)
 * and generated sets sweep every decision band (approve/queue/reject/ban).
 */
function deterministicScore(text: string): number {
	let hash = 0;
	for (let index = 0; index < text.length; index += 1) {
		hash = (hash * 31 + text.charCodeAt(index)) % 100;
	}
	return hash / 100;
}

const SCORE_CATEGORIES = [
	'harassment',
	'harassment/threatening',
	'hate',
	'hate/threatening',
	'illicit',
	'illicit/violent',
	'self-harm',
	'self-harm/intent',
	'self-harm/instructions',
	'sexual',
	'sexual/minors',
	'violence',
	'violence/graphic'
] as const;

/** A full ToxicityScores with every category at the same score. */
function scoresFor(score: number): ToxicityScores {
	return Object.fromEntries(SCORE_CATEGORIES.map((category) => [category, score])) as ToxicityScores;
}

/** Seeds the high-credit org row the ledger gate needs (a huge balance keeps
 * consumption irrelevant to the ingest properties under test). No-op for
 * org-less channels. Shared by every property so the fixture lives once. */
async function seedOrgFor(orgId: string | null): Promise<void> {
	if (orgId === null) return;
	await testDb().db.insert(organizations).values({
		id: orgId,
		name: `Org ${orgId}`,
		creditsRemaining: 1_000_000
	});
}

/** Seeds the generated channel row (tone level 1 — no tone pass, no video metadata call). */
async function seedChannel(channel: ChannelRow): Promise<void> {
	await testDb().db.insert(channels).values({
		id: channel.id,
		userId: channel.userId,
		orgId: channel.orgId,
		title: channel.title,
		refreshTokenEnc: channel.refreshTokenEnc
	});
	// A channel carrying an orgId needs its org row: the ledger gates AI
	// scoring on the balance and fails loudly for a missing org (never a
	// silent "no credits").
	await seedOrgFor(channel.orgId);
}

function by<T>(rows: T[], key: (row: T) => string | number): T[] {
	return [...rows].sort((x, y) => {
		const kx = key(x);
		const ky = key(y);
		return kx < ky ? -1 : kx > ky ? 1 : 0;
	});
}

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
			await wipeTables(WIPE); // fresh state per run, not per test
			await seedChannel(run.channel);
			const pageComments = [...run.set, ...run.duplicates];
			const page: CommentPage = { comments: pageComments, nextPageToken: null, reachedCursor: true };
			mocks.fetchNewComments.mockResolvedValue(page);
			mocks.scoreComment.mockImplementation(async (text: string) => {
				const score = deterministicScore(text);
				return { score, scores: scoresFor(score) };
			});

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
	// null assertions. Skipping enforcement of scored comments (or enforcing
	// failed ones) breaks the moderation_actions oracle; miscounting the queue
	// breaks result.queued.
	await fc.assert(
		fc.asyncProperty(failureRunArb, async (run) => {
			await wipeTables(WIPE);
			await seedChannel(run.channel);
			const page: CommentPage = { comments: run.set, nextPageToken: null, reachedCursor: true };
			mocks.fetchNewComments.mockResolvedValue(page);
			// The scorer sees only text, so the generated per-comment mask lands on
			// the comment's text: comments sharing a masked text fail together, and
			// the expectations below use the same text-keyed predicate.
			const failedTexts = new Set(run.set.filter((_, index) => run.mask[index]).map((comment) => comment.text));
			mocks.scoreComment.mockImplementation(async (text: string) => {
				if (failedTexts.has(text)) throw new Error(run.errorMessage);
				return { score: 0.99, scores: scoresFor(0.99) }; // ≥ AUTO_BAN 0.95 → ban
			});

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
					expect(row.status).toBe('rejected');
					expect(row.decidedBy).toBe('ai');
				}
			}
			expect(result.queued).toBe(expectedQueued);
			// Scored (non-failed) comments are still enforced; failed ones are not.
			expect(actions).toHaveLength(run.set.length - expectedQueued);
			for (const action of actions) {
				expect(action.action).toBe('ban');
				expect(action.state).toBe('completed');
			}
			expect(audits.filter((row) => row.action === 'queue')).toHaveLength(expectedQueued);
		})
	);
});
