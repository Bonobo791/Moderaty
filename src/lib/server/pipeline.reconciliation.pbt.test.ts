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

// Property tests for pipeline reconciliation (I3), dry-run conservation (I8),
// and scan boundedness/cursor monotonicity (I10) — same testdb harness as
// pipeline.pbt.test.ts: the REAL in-memory database, with only the
// network/env seams mocked (YouTube API calls, the AI scorers, BYOK key
// resolution, token decryption, $env/dynamic/private). Rule preparation
// (recheck unmocked — only keyword rules are seeded here), the deadline
// helpers, and serializeScores stay real.
//
// I3 approach: a GENERATED SEQUENCE of pass plans (per-pass seam failure
// masks plus observed verification statuses) drives repeated runChannel
// passes. fc.commands/fc.scheduler were considered and rejected: runChannel
// is strictly sequential per channel, so a generated sequence exercises the
// same state space with a far simpler oracle — no interleavings exist to
// schedule.

import { eq } from 'drizzle-orm';
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
	getCommentModerationStatus: vi.fn(async (_id: string): Promise<string | null> => null),
	setModerationStatus: vi.fn(async (_ids: string[]) => {}),
	deleteComment: vi.fn(async (_id: string) => {}),
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
import { auditLog, channels, comments, moderationActions, rules } from './db/schema';
import { runChannel, type ChannelRunResult } from './pipeline';
import type { ToxicityScores } from './moderation';
import type { CommentModerationStatus, CommentPage, FetchCommentsOptions, NewComment } from './youtube';
import {
	RULE_ACTIONS,
	channelIdArb,
	channelRowArb,
	commentTextArb,
	idArb,
	isoTimestampArb,
	overLimitTextArb,
	pastIsoArb,
	toIso,
	type ChannelRow
} from './testarbitraries';

const WIPE = ['moderation_actions', 'comments', 'audit_log', 'rules', 'channels'];

// Each property is ONE vitest test running pbtNumRuns() predicates; a
// FC_NUM_RUNS=1000 burn-in of multi-pass runChannel predicates blows past
// vitest's 5s default, so the timeout is explicit (default runs take <1s).
const BURN_IN_TIMEOUT = 120_000;

setupTestDb(WIPE);

beforeEach(() => {
	vi.clearAllMocks();
});

type ActionType = (typeof RULE_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Shared generated input and helpers (mirrors pipeline.pbt.test.ts)
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

/** Deterministic scorer: a pure hash of the comment text into [0, 0.99]. */
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

/** Deterministic scorer mock implementation shared by all three properties. */
async function scoreDeterministically(text: string) {
	const score = deterministicScore(text);
	return { score, scores: scoresFor(score) };
}

/** Seeds the generated channel row, bare (tone level 1, no cursor fields). */
async function seedChannel(channel: ChannelRow): Promise<void> {
	await testDb().db.insert(channels).values({
		id: channel.id,
		userId: channel.userId,
		orgId: channel.orgId,
		title: channel.title,
		refreshTokenEnc: channel.refreshTokenEnc
	});
}

function by<T>(rows: T[], key: (row: T) => string | number): T[] {
	return [...rows].sort((x, y) => {
		const kx = key(x);
		const ky = key(y);
		return kx < ky ? -1 : kx > ky ? 1 : 0;
	});
}

async function channelRow(channelId: string) {
	const row = await testDb().db.select().from(channels).where(eq(channels.id, channelId)).get();
	if (!row) throw new Error(`channel ${channelId} missing from the test database`);
	return row;
}

/**
 * Re-installs the hoisted default seam behavior. vi.clearAllMocks() drops
 * call history but keeps implementations, and property-1's per-pass
 * implementations carry per-predicate closures — without this they leak into
 * the next test file section and fire their guards against foreign data.
 */
function resetSeamDefaults(): void {
	mocks.getCommentModerationStatus.mockImplementation(async () => null);
	mocks.setModerationStatus.mockImplementation(async () => {});
	mocks.deleteComment.mockImplementation(async () => {});
}

// ---------------------------------------------------------------------------
// I3 — reconciliation convergence
// ---------------------------------------------------------------------------

interface SeededAction {
	commentId: string;
	action: ActionType;
	state: 'pending' | 'dispatched';
	reason: string;
	lastAttemptAt: string | null;
}

interface PassPlan {
	verifyThrows: boolean;
	setFails: boolean;
	deleteFails: boolean;
	observed: CommentModerationStatus | null;
	seamMessage: string;
}

/** Comment status left by the original decision for each action type (the
 * reconciler never rewrites it — stageDecisions owns comments.status). */
const COMMENT_STATUS_BY_ACTION: Record<ActionType, string> = {
	hold: 'held',
	reject: 'rejected',
	delete: 'deleted',
	ban: 'rejected'
};

/**
 * A channel plus outstanding moderation_actions in generated states, plus one
 * pass plan per pass (actions + 2 passes; the last pass is forced clean, so a
 * bounded run must converge). lastAttemptAt ages are generated against a
 * generated "now" — time enters as data, never from the clock.
 */
const reconciliationArb = fc
	.tuple(
		channelRowArb,
		fc
			.date({ min: new Date(Date.UTC(2021, 0, 1)), max: new Date(Date.UTC(2035, 11, 31)), noInvalidDate: true })
			.map((date) => date.getTime())
	)
	.chain(([channel, nowMs]) =>
		fc
			.uniqueArray(
				fc.record({
					commentId: idArb,
					action: fc.constantFrom(...RULE_ACTIONS),
					state: fc.constantFrom('pending', 'dispatched'),
					reason: fc.string({ minLength: 1, maxLength: 80 }),
					lastAttemptAt: fc.option(pastIsoArb(nowMs), { nil: null })
				}),
				{ minLength: 0, maxLength: 6, selector: (action) => action.commentId }
			)
			.chain((actions) =>
				fc.record({
					channel: fc.constant(channel),
					nowMs: fc.constant(nowMs),
					actions: fc.constant(actions),
					passes: fc.array(
						fc.record({
							verifyThrows: fc.boolean(),
							setFails: fc.boolean(),
							deleteFails: fc.boolean(),
							observed: fc.constantFrom<CommentModerationStatus | null>(
								'published',
								'heldForReview',
								'rejected',
								'likelySpam',
								null
							),
							seamMessage: fc.string({ minLength: 1, maxLength: 60 })
						}),
						{ minLength: actions.length + 2, maxLength: actions.length + 2 }
					)
				})
			)
	);

test('I3: bounded passes converge outstanding actions; completion requires enforcement or a verified terminal state', async () => {
	// Property audit: dropping claimPendingActions leaves seeded 'pending' rows
	// unclaimed forever — the final all-completed assertion goes red. Dropping
	// the verification retry→ready path (a retried dispatched action never
	// re-applied) strands rows in 'dispatched' — same red. Completing an action
	// WITHOUT enforcement or a verified terminal state (a silent complete)
	// breaks the enforcedIds ∪ verifiedTerminal totality assertion. Deleting or
	// un-completing rows breaks the count/monotonicity assertions; a missing or
	// doubled completion audit row breaks the exact audit multiset. A swallowed
	// verification failure (no throw, row quietly retried) stays convergent —
	// that loud-throw contract is pinned by the example tests
	// ('keeps a dispatched action retriable when verification fails transiently').
	await fc.assert(
		fc.asyncProperty(reconciliationArb, async (run) => {
			await wipeTables(WIPE); // fresh state per run, not per test
			vi.clearAllMocks();
			resetSeamDefaults();
			await seedChannel(run.channel);
			const db = testDb().db;
			// The comments the outstanding actions belong to: decided rows, as a
			// completed decision would have left them. Reconciliation must never
			// rewrite them (status was fixed at decision time).
			for (const action of run.actions) {
				await db.insert(comments).values({
					id: action.commentId,
					channelId: run.channel.id,
					text: `seeded comment ${action.commentId}`,
					publishedAt: toIso(run.nowMs),
					status: COMMENT_STATUS_BY_ACTION[action.action],
					decidedBy: 'ai'
				});
				await db.insert(moderationActions).values({
					commentId: action.commentId,
					channelId: run.channel.id,
					action: action.action,
					reason: action.reason,
					state: action.state,
					lastAttemptAt: action.lastAttemptAt,
					lastManualRetryAt: null
				});
			}
			const seededComments = by(await db.select().from(comments).all(), (row) => row.id);
			const seededChannel = await channelRow(run.channel.id);
			const actionById = new Map(run.actions.map((action) => [action.commentId, action.action]));

			// Every pass presents an empty page: the run is pure reconciliation.
			const page: CommentPage = { comments: [], nextPageToken: null, reachedCursor: true };
			mocks.fetchNewComments.mockResolvedValue(page);
			mocks.scoreComment.mockImplementation(async () => {
				throw new Error('scoreComment must not be called: the reconciliation page is empty');
			});
			// Completion-honesty tracking: a 'completed' row is only legitimate via
			// a successful enforcement call or a verification that observed the
			// terminal state for that action type.
			const enforcedIds = new Set<string>();
			const verifiedTerminal = new Set<string>();

			let completedBefore = new Set<string>();
			let finalResult: ChannelRunResult | null = null;
			for (const [passIndex, plan] of run.passes.entries()) {
				// The final pass is forced clean: a bounded run must converge.
				const lastPass = passIndex === run.passes.length - 1;
				const verifyThrows = plan.verifyThrows && !lastPass;
				const setFails = plan.setFails && !lastPass;
				const deleteFails = plan.deleteFails && !lastPass;
				mocks.getCommentModerationStatus.mockImplementation(async (id: string) => {
					const action = actionById.get(id);
					if (!action) throw new Error(`verification of untracked comment ${id}`);
					if (verifyThrows) throw new Error(plan.seamMessage);
					const terminal =
						(action === 'delete' && plan.observed === null) ||
						(action === 'hold' && plan.observed === 'heldForReview') ||
						(action === 'reject' && plan.observed === 'rejected') ||
						(action === 'ban' && (plan.observed === 'rejected' || plan.observed === null));
					if (terminal) verifiedTerminal.add(id);
					return plan.observed;
				});
				mocks.setModerationStatus.mockImplementation(async (ids: string[]) => {
					for (const id of ids) {
						if (!actionById.has(id)) throw new Error(`enforcement of untracked comment ${id}`);
					}
					if (setFails) throw new Error(plan.seamMessage);
					for (const id of ids) enforcedIds.add(id);
				});
				mocks.deleteComment.mockImplementation(async (id: string) => {
					if (!actionById.has(id)) throw new Error(`enforcement of untracked comment ${id}`);
					if (deleteFails) throw new Error(plan.seamMessage);
					enforcedIds.add(id);
				});
				const clean = !verifyThrows && !setFails && !deleteFails;

				let threw: Error | null = null;
				let result: ChannelRunResult | null = null;
				try {
					result = await runChannel(run.channel.id);
				} catch (error) {
					// Seam failures surface as LOUD run failures (a verification failure
					// aborts the run by design; enforcement errors propagate raw) —
					// never as silently dropped work.
					if (!(error instanceof Error)) throw error;
					threw = error;
				}
				if (clean) {
					expect(threw).toBeNull();
					finalResult = result;
				} else if (threw) {
					expect(threw.message).toContain(plan.seamMessage);
				}

				const rows = await db.select().from(moderationActions).all();
				// Never silently dropped, never duplicated.
				expect(rows).toHaveLength(run.actions.length);
				for (const row of rows) {
					expect(row.channelId).toBe(run.channel.id);
					expect(['pending', 'dispatched', 'completed']).toContain(row.state);
				}
				// Real retry semantics: claimPendingActions flips every 'pending' row
				// to 'dispatched' BEFORE enforcement (I3: DB before remote), so no
				// row is ever 'pending' after the first pass — a failed apply leaves
				// it 'dispatched', which the next pass re-verifies and retries.
				expect(rows.some((row) => row.state === 'pending')).toBe(false);
				// Completion is one-way: a completed action is never re-opened.
				const completedNow = new Set(
					rows.filter((row) => row.state === 'completed').map((row) => row.commentId)
				);
				for (const id of completedBefore) expect(completedNow.has(id)).toBe(true);
				// One fully clean pass converges EVERY outstanding action, from any
				// mix of states and observed verification statuses.
				if (clean) expect(rows.every((row) => row.state === 'completed')).toBe(true);
				completedBefore = completedNow;
			}

			if (!finalResult) throw new Error('the forced-clean final pass did not produce a result');
			expect(finalResult).toMatchObject({ fetched: 0, skipped: false, partial: false, dryRun: false });

			// Convergence: every action completed within actions + 2 passes.
			const finalRows = await db.select().from(moderationActions).all();
			for (const row of finalRows) expect(row.state).toBe('completed');
			// Completion honesty: enforced at least once, or verified terminal.
			for (const action of run.actions) {
				expect(enforcedIds.has(action.commentId) || verifiedTerminal.has(action.commentId)).toBe(true);
			}
			// Exactly one completion audit row per action, carrying its reason.
			const audits = await db.select().from(auditLog).all();
			expect(audits).toHaveLength(run.actions.length);
			for (const row of audits) {
				expect(row.channelId).toBe(run.channel.id);
				expect(row.actor).toBe('system');
				expect(row.text).toBeNull();
			}
			const expectedKeys = run.actions
				.map((action) => `${action.commentId}|${action.action}|${action.reason}`)
				.sort();
			const actualKeys = audits
				.map((row) => `${row.commentId}|${row.action}|${row.reason}`)
				.sort();
			expect(actualKeys).toEqual(expectedKeys);
			// The reconciler never rewrites decided comments or the channel row
			// (an empty reached-cursor page persists only null checkpoints).
			expect(by(await db.select().from(comments).all(), (row) => row.id)).toEqual(seededComments);
			expect(await channelRow(run.channel.id)).toEqual(seededChannel);
		})
	);
}, BURN_IN_TIMEOUT);

// ---------------------------------------------------------------------------
// I8 — dry-run conservation
// ---------------------------------------------------------------------------

/** 0–20 comments, unique ids by construction. */
const commentSetArb = fc.uniqueArray(newCommentArb, {
	minLength: 0,
	maxLength: 20,
	selector: (comment) => comment.id
});

/**
 * A channel, a comment page, a subset of the page pre-stored by an earlier
 * real run, generated keyword rules, and generated outstanding actions —
 * everything a dry run must leave byte-identical.
 */
const dryRunArb = fc.tuple(channelRowArb, commentSetArb).chain(([channel, set]) =>
	fc.record({
		channel: fc.constant(channel),
		set: fc.constant(set),
		preStored: fc.subarray(set),
		keywordRules: fc.array(
			fc.record({
				pattern: fc.string({ minLength: 1, maxLength: 30 }),
				action: fc.constantFrom(...RULE_ACTIONS)
			}),
			{ minLength: 0, maxLength: 2 }
		),
		outstanding: fc.uniqueArray(
			fc.record({
				commentId: idArb,
				action: fc.constantFrom(...RULE_ACTIONS),
				state: fc.constantFrom('pending', 'dispatched'),
				reason: fc.string({ minLength: 1, maxLength: 60 })
			}),
			{ minLength: 0, maxLength: 3, selector: (action) => action.commentId }
		)
	})
);

/** Whole-database dump of every table a channel run may touch. */
async function snapshotAll() {
	const db = testDb().db;
	return {
		comments: by(await db.select().from(comments).all(), (row) => row.id),
		moderationActions: by(await db.select().from(moderationActions).all(), (row) => row.commentId),
		auditLog: by(await db.select().from(auditLog).all(), (row) => row.id),
		rules: by(await db.select().from(rules).all(), (row) => row.id),
		channels: by(await db.select().from(channels).all(), (row) => row.id)
	};
}

test('I8: a forced dry run changes nothing durable except dry-run audit rows (text ≤ 500)', async () => {
	// Property audit: inserting comments or staging moderation_actions under
	// dry-run breaks the byte-identity assertions (a re-inserted pre-stored id
	// also throws on the comments PRIMARY KEY). Reaching
	// processOutstandingActions trips the never-called spies and the
	// moderation_actions byte-identity. Persisting cursor/scanCursor/
	// nextPageToken (or the dry-run drain fields in non-window mode) breaks the
	// channels byte-identity. An audit row with a real action name, missing
	// text, or untruncated >500-char text breaks the gained-row oracle; a
	// missing audit row breaks the exact count.
	await fc.assert(
		fc.asyncProperty(dryRunArb, async (run) => {
			await wipeTables(WIPE);
			vi.clearAllMocks();
			resetSeamDefaults();
			await seedChannel(run.channel);
			const db = testDb().db;
			// Comments an earlier REAL run already stored: decided rows, text
			// already truncated. Non-window dry runs dedupe against them exactly
			// like live runs (window-mode rescoring is not under test here).
			for (const comment of run.preStored) {
				await db.insert(comments).values({
					id: comment.id,
					channelId: run.channel.id,
					text: comment.text.slice(0, 500),
					publishedAt: comment.publishedAt,
					status: 'approved',
					decidedBy: 'ai'
				});
			}
			for (const rule of run.keywordRules) {
				await db.insert(rules).values({
					channelId: run.channel.id,
					type: 'keyword',
					pattern: rule.pattern,
					action: rule.action
				});
			}
			for (const action of run.outstanding) {
				await db.insert(moderationActions).values({
					commentId: action.commentId,
					channelId: run.channel.id,
					action: action.action,
					reason: action.reason,
					state: action.state,
					lastAttemptAt: null,
					lastManualRetryAt: null
				});
			}
			// A pre-existing audit row: the dry run may only APPEND.
			await db.insert(auditLog).values({
				channelId: run.channel.id,
				commentId: 'legacy-comment',
				action: 'approve',
				reason: 'seeded history',
				actor: 'system'
			});
			const before = await snapshotAll();

			const page: CommentPage = { comments: run.set, nextPageToken: null, reachedCursor: true };
			mocks.fetchNewComments.mockResolvedValue(page);
			mocks.scoreComment.mockImplementation(scoreDeterministically);

			// env DRY_RUN is 'false': forceDryRun alone drives dry-run semantics.
			const result = await runChannel(run.channel.id, { forceDryRun: true });
			expect(result).toMatchObject({
				fetched: run.set.length,
				skipped: false,
				partial: false,
				dryRun: true
			});

			// The enforcement seams were never touched — not even for the
			// outstanding actions (a dry run never reconciles).
			expect(mocks.setModerationStatus).not.toHaveBeenCalled();
			expect(mocks.deleteComment).not.toHaveBeenCalled();
			expect(mocks.getCommentModerationStatus).not.toHaveBeenCalled();

			const after = await snapshotAll();
			expect(after.comments).toEqual(before.comments);
			expect(after.moderationActions).toEqual(before.moderationActions);
			expect(after.rules).toEqual(before.rules);
			// Cursor, scanCursor, nextPageToken, lease and dry-run-drain fields:
			// all untouched (whole-row byte-identity).
			expect(after.channels).toEqual(before.channels);

			// audit_log: the pre-existing rows plus exactly one 'dry-run' row per
			// new decision (pre-stored comments are deduped, never re-audited).
			const preStoredIds = new Set(run.preStored.map((comment) => comment.id));
			const expectedDecisions = run.set.filter((comment) => !preStoredIds.has(comment.id));
			expect(after.auditLog.length).toBe(before.auditLog.length + expectedDecisions.length);
			expect(after.auditLog.slice(0, before.auditLog.length)).toEqual(before.auditLog);
			const gained = after.auditLog.slice(before.auditLog.length);
			const sourceById = new Map(run.set.map((comment) => [comment.id, comment]));
			for (const row of gained) {
				expect(row.action).toBe('dry-run');
				expect(row.actor).toBe('system');
				expect(row.channelId).toBe(run.channel.id);
				expect(preStoredIds.has(row.commentId)).toBe(false);
				const source = sourceById.get(row.commentId);
				if (!source) throw new Error(`dry-run audit row for ${row.commentId} was not in the generated page`);
				// Dry-run rows carry the comment text themselves (no comments row
				// exists), capped at 500 chars like comments.text.
				expect(row.text).toBe(source.text.slice(0, 500));
				expect(row.text?.length).toBeLessThanOrEqual(500);
				expect(row.reason.length).toBeGreaterThan(0);
			}
		})
	);
}, BURN_IN_TIMEOUT);

// ---------------------------------------------------------------------------
// I10 — boundedness, cursor monotonicity, resume without duplicates
// ---------------------------------------------------------------------------

interface SeamCall {
	cursor: string | null;
	maxPages: number | undefined;
	pageToken: string | null;
	walked: string[];
}

interface PagedRun {
	channel: ChannelRow;
	/** Pages in YouTube order (newest first), with optional boundary overlap. */
	pages: NewComment[][];
	/** The unique comment pool, sorted by publishedAt descending. */
	pool: NewComment[];
	/** Channel cursor: always older than (or equal to) every generated comment. */
	cursor: string | null;
	maxPages: number;
}

/** Run 2 always gets enough pages to drain whatever remains. */
const MAX_PAGES_2 = 6;

/**
 * 1–6 pages of comments (unique ids, sorted newest-first like YouTube's
 * order=time, with an optional repeated item at each page boundary — real
 * commentThreads pagination overlaps), a maxPages of 1–3, and a cursor
 * candidate clamped below every comment by construction.
 */
const pagedRunArb: fc.Arbitrary<PagedRun> = fc.integer({ min: 1, max: 6 }).chain((pageCount) =>
	fc
		.tuple(
			channelRowArb,
			fc.uniqueArray(newCommentArb, {
				minLength: pageCount,
				maxLength: pageCount * 4,
				selector: (comment) => comment.id
			}),
			fc.integer({ min: 1, max: 3 }),
			fc.option(isoTimestampArb, { nil: null })
		)
		.map(([channel, poolRaw, maxPages, cursorCandidate]) => {
			const pool = [...poolRaw].sort(
				(a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
			);
			const base = Math.floor(pool.length / pageCount);
			const remainder = pool.length % pageCount;
			const pages: NewComment[][] = [];
			let offset = 0;
			for (let index = 0; index < pageCount; index += 1) {
				const size = base + (index < remainder ? 1 : 0);
				pages.push(pool.slice(offset, offset + size));
				offset += size;
			}
			// Page-boundary overlap: the last item of page i re-appears at the head
			// of page i+1 (same id AND text — the real pagination behavior).
			for (let index = 1; index < pageCount; index += 1) {
				pages[index] = [pages[index - 1][pages[index - 1].length - 1], ...pages[index]];
			}
			const minPublished = Math.min(...pool.map((comment) => Date.parse(comment.publishedAt)));
			const candidateMs = cursorCandidate === null ? null : Date.parse(cursorCandidate);
			const cursorMs = Math.min(candidateMs ?? Infinity, minPublished - 1);
			const cursor = Number.isFinite(cursorMs) ? toIso(cursorMs) : null;
			return { channel, pages, pool, cursor, maxPages };
		})
);

test('I10: a run fetches at most maxPages, the cursor never regresses, and the next run resumes without duplicates', async () => {
	// Property audit: runChannel ignoring its maxPages option (a hardcoded
	// default) breaks the per-call maxPages spy whenever the generated value
	// differs. Not persisting nextPageToken (or persisting it wrong) breaks the
	// resume assertion on run 2's first seam call; committing the live cursor
	// before the scan completes breaks the mid-scan cursor assertion, and a
	// regressed cursor breaks instant monotonicity. Dropping the stored-ids
	// dedupe makes run 2 re-insert the boundary overlap — the staging
	// transaction throws on the comments PRIMARY KEY (red); dropping the
	// within-batch dedupe does the same inside a single run.
	await fc.assert(
		fc.asyncProperty(pagedRunArb, async (run) => {
			await wipeTables(WIPE);
			vi.clearAllMocks();
			resetSeamDefaults();
			await testDb().db.insert(channels).values({
				id: run.channel.id,
				userId: run.channel.userId,
				orgId: run.channel.orgId,
				title: run.channel.title,
				refreshTokenEnc: run.channel.refreshTokenEnc,
				cursor: run.cursor
			});
			const db = testDb().db;

			// Paginated fetchNewComments seam: mirrors the real one (walks up to
			// maxPages API pages from the initial token, stops at the cursor).
			const calls: SeamCall[] = [];
			mocks.fetchNewComments.mockImplementation(
				async (
					_channelId: string,
					_accessToken: string,
					cursor: string | null,
					options: FetchCommentsOptions = {}
				): Promise<CommentPage> => {
					const record: SeamCall = {
						cursor,
						maxPages: options.maxPages,
						pageToken: options.pageToken ?? null,
						walked: []
					};
					calls.push(record);
					const limit = options.maxPages ?? 3;
					const cursorMs = cursor === null ? null : Date.parse(cursor);
					const out: NewComment[] = [];
					let index = record.pageToken === null ? 0 : Number(record.pageToken.slice(1));
					for (let page = 0; page < limit; page += 1) {
						if (index >= run.pages.length) {
							return { comments: out, nextPageToken: null, reachedCursor: false };
						}
						record.walked.push(`p${index}`);
						let reached = false;
						for (const comment of run.pages[index]) {
							if (cursorMs !== null && Date.parse(comment.publishedAt) < cursorMs) {
								reached = true;
								break;
							}
							out.push(comment);
						}
						if (reached) return { comments: out, nextPageToken: null, reachedCursor: true };
						index += 1;
						if (index >= run.pages.length) {
							return { comments: out, nextPageToken: null, reachedCursor: false };
						}
					}
					return { comments: out, nextPageToken: `p${index}`, reachedCursor: false };
				}
			);
			mocks.scoreComment.mockImplementation(scoreDeterministically);

			// The scan's high-water mark: the pool is sorted newest-first.
			const newest = run.pool.reduce(
				(best, comment) => (Date.parse(comment.publishedAt) > Date.parse(best) ? comment.publishedAt : best),
				run.pool[0].publishedAt
			);
			const cursorBeforeMs = run.cursor === null ? -Infinity : Date.parse(run.cursor);
			// Independent restatement of the seam contract (walk up to `limit`
			// pages from `startIndex`, stop at the first comment strictly older
			// than the cursor) used to derive expectations: run 2 re-scans with
			// the committed high-water cursor, so its walk can stop mid-page.
			const simulateWalk = (startIndex: number, cursor: string | null, limit: number) => {
				const cursorMs = cursor === null ? null : Date.parse(cursor);
				const walked: string[] = [];
				const out: NewComment[] = [];
				let index = startIndex;
				for (let page = 0; page < limit; page += 1) {
					if (index >= run.pages.length) break;
					walked.push(`p${index}`);
					let reached = false;
					for (const comment of run.pages[index]) {
						if (cursorMs !== null && Date.parse(comment.publishedAt) < cursorMs) {
							reached = true;
							break;
						}
						out.push(comment);
					}
					index += 1;
					if (reached) break;
				}
				return { walked, out };
			};

			// --- Run 1: bounded by the generated maxPages.
			const expected1 = simulateWalk(0, run.cursor, run.maxPages);
			const result1 = await runChannel(run.channel.id, { maxPages: run.maxPages });
			const after1 = await channelRow(run.channel.id);

			// The configured maxPages is threaded into the seam, unchanged.
			expect(calls).toHaveLength(1);
			expect(calls[0].maxPages).toBe(run.maxPages);
			expect(calls[0].pageToken).toBeNull();
			expect(calls[0].cursor).toBe(run.cursor);
			// Boundedness: at most maxPages API pages were walked.
			expect(calls[0].walked).toEqual(expected1.walked);
			expect(calls[0].walked.length).toBeLessThanOrEqual(run.maxPages);
			expect(result1.fetched).toBe(expected1.out.length);
			// ChannelRunResult.partial is deadline-only; an incomplete scan is
			// expressed on the channel row (nextPageToken/scanCursor), never here.
			expect(result1.partial).toBe(false);
			expect(result1.dryRun).toBe(false);

			// Run 1's cursor sits below every generated comment, so the walk only
			// ever stops by exhausting pages or maxPages.
			const expectedWalked1 = Math.min(run.maxPages, run.pages.length);
			expect(expected1.walked).toEqual(Array.from({ length: expectedWalked1 }, (_, index) => `p${index}`));
			const drained1 = expectedWalked1 === run.pages.length;
			if (drained1) {
				expect(after1.nextPageToken).toBeNull();
				expect(after1.scanCursor).toBeNull();
				expect(after1.cursor).toBe(newest);
			} else {
				// Mid-scan: the live cursor holds, the high-water moves to scanCursor.
				expect(after1.nextPageToken).toBe(`p${expectedWalked1}`);
				expect(after1.scanCursor).toBe(newest);
				expect(after1.cursor).toBe(run.cursor);
			}
			// Instant monotonicity: the cursor never regresses.
			const after1CursorMs = after1.cursor === null ? -Infinity : Date.parse(after1.cursor);
			expect(after1CursorMs).toBeGreaterThanOrEqual(cursorBeforeMs);
			// Stored rows: the unique ids covered by the walked pages (boundary
			// overlap deduped within the batch).
			const covered1 = new Set(expected1.out.map((comment) => comment.id));
			expect(await db.select().from(comments).all()).toHaveLength(covered1.size);

			// --- Run 2: resumes from the persisted checkpoint and drains.
			const start2 = drained1 ? 0 : expectedWalked1;
			const expected2 = simulateWalk(start2, after1.cursor, MAX_PAGES_2);
			const result2 = await runChannel(run.channel.id, { maxPages: MAX_PAGES_2 });
			const after2 = await channelRow(run.channel.id);

			expect(calls).toHaveLength(2);
			expect(calls[1].maxPages).toBe(MAX_PAGES_2);
			// Resume: run 2 starts exactly where run 1 stopped (or re-scans from
			// the top against the committed cursor when run 1 already drained —
			// either way dedupe makes re-presented comments a no-op) and never
			// re-fetches pages run 1 completed.
			expect(calls[1].pageToken).toBe(drained1 ? null : `p${expectedWalked1}`);
			expect(calls[1].cursor).toBe(after1.cursor);
			expect(calls[1].walked).toEqual(expected2.walked);
			expect(calls[1].walked.length).toBeLessThanOrEqual(MAX_PAGES_2);
			expect(result2.partial).toBe(false);
			expect(result2.fetched).toBe(expected2.out.length);

			// No duplicates across the two runs: exactly the unique pool survives
			// (I4 at the page boundary — a missed dedupe throws on the PRIMARY KEY).
			const stored = await db.select().from(comments).all();
			expect(stored).toHaveLength(run.pool.length);
			expect(by(stored, (row) => row.id).map((row) => row.id)).toEqual(
				by(run.pool, (comment) => comment.id).map((comment) => comment.id)
			);
			// The completed scan commits the high-water cursor; never a regression.
			expect(after2.cursor).toBe(newest);
			expect(after2.nextPageToken).toBeNull();
			expect(after2.scanCursor).toBeNull();
			expect(Date.parse(after2.cursor ?? '')).toBeGreaterThanOrEqual(after1CursorMs);
		})
	);
}, BURN_IN_TIMEOUT);
