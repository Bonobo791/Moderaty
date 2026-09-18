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

// Shared fixtures for the pipeline property tests: the hoisted seam-mock
// factory, generated input shapes, the deterministic scorer, and the DB
// seeders. pipeline.pbt.test.ts and pipeline.reconciliation.pbt.test.ts keep
// their own vi.hoisted/vi.mock wiring (per-module vitest requirement) but
// call these factories via `await import('./pbt-support')` inside them, so
// the implementations live once instead of drifting as parallel copies.

import { eq } from 'drizzle-orm';
import fc from 'fast-check';
import { vi } from 'vitest';
import { testDb } from './testdb';
import { channels, organizations } from './db/schema';
import type { ToxicityScores } from './moderation';
import type { CommentModerationStatus, NewComment } from './youtube';
import {
	channelIdArb,
	commentTextArb,
	idArb,
	isoTimestampArb,
	overLimitTextArb,
	type ChannelRow
} from './testarbitraries';

/** Tables every pipeline property wipes between runs. */
export const PBT_WIPE = [
	'moderation_actions',
	'comments',
	'audit_log',
	'rules',
	'channels',
	'organizations',
	'credit_transactions'
];

/**
 * The seam-mock object every pipeline PBT file hoists. Call inside
 * `vi.hoisted` via `await import('./pbt-support')` — static imports cannot be
 * referenced there. FC_NUM_RUNS rides through the env mock so
 * testarbitraries.ts keeps honoring the burn-in knob (it reads
 * $env/dynamic/private at import time).
 */
export function createPipelineMocks() {
	return {
		env: { DRY_RUN: 'false', FC_NUM_RUNS: process.env.FC_NUM_RUNS } as Record<
			string,
			string | undefined
		>,
		decrypt: vi.fn(() => 'refresh-token'),
		refreshAccessToken: vi.fn(async () => 'access-token'),
		fetchNewComments: vi.fn(),
		fetchVideoMetadata: vi.fn(async () => new Map()),
		getCommentModerationStatus: vi.fn(async (_id: string): Promise<CommentModerationStatus | null> => null),
		setModerationStatus: vi.fn(async (_ids: string[]) => {}),
		deleteComment: vi.fn(async (_id: string) => {}),
		scoreComment: vi.fn(),
		scoreTone: vi.fn(),
		resolveOpenAiKey: vi.fn(async () => 'test-openai-key')
	};
}

export type PipelineMocks = ReturnType<typeof createPipelineMocks>;

/** $lib/server/moderation vi.mock body: serializeScores stays real (pure
 * JSON); only the network scorer is mocked. */
export async function moderationMockModule(
	importOriginal: <T>() => Promise<T>,
	mocks: PipelineMocks
) {
	return {
		...(await importOriginal<typeof import('./moderation')>()),
		scoreComment: mocks.scoreComment
	};
}

/** $lib/server/youtube vi.mock body shared by every pipeline PBT file.
 * Real exports (YOUTUBE_ID_BATCH_SIZE, types) survive; only the network
 * calls are faked so the constant cannot drift between mock and source. */
export async function youtubeMockModule(mocks: PipelineMocks) {
	return {
		...(await vi.importActual<typeof import('./youtube')>('./youtube')),
		refreshAccessToken: mocks.refreshAccessToken,
		fetchNewComments: mocks.fetchNewComments,
		fetchVideoMetadata: mocks.fetchVideoMetadata,
		getCommentModerationStatus: mocks.getCommentModerationStatus,
		setModerationStatus: mocks.setModerationStatus,
		deleteComment: mocks.deleteComment
	};
}

// ---------------------------------------------------------------------------
// Generated input: NewComment-shaped data (the youtube.ts parser's OUTPUT —
// item-level malformed fuzz lives at the parser level, testarbitraries.test.ts)
// ---------------------------------------------------------------------------

/** A NewComment with storage-contract-hostile text (≤500 and 501–600 chars mixed). */
export const newCommentArb: fc.Arbitrary<NewComment> = fc.record({
	id: idArb,
	threadId: idArb,
	videoId: fc.option(idArb, { nil: null }),
	authorChannelId: channelIdArb,
	authorName: fc.string({ maxLength: 40 }),
	text: fc.oneof(commentTextArb, overLimitTextArb),
	publishedAt: isoTimestampArb
});

/** 0–20 comments, unique ids by construction. */
export const commentSetArb = fc.uniqueArray(newCommentArb, {
	minLength: 0,
	maxLength: 20,
	selector: (comment) => comment.id
});

/**
 * Deterministic scorer: a pure hash of the comment text into [0, 0.99], so the
 * same text always decides identically across runs (idempotency needs that)
 * and generated sets sweep every decision band (approve/queue/delete/ban).
 */
export function deterministicScore(text: string): number {
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
export function scoresFor(score: number): ToxicityScores {
	return Object.fromEntries(SCORE_CATEGORIES.map((category) => [category, score])) as ToxicityScores;
}

/** Deterministic scorer mock implementation shared by the properties. */
export async function scoreDeterministically(text: string) {
	const score = deterministicScore(text);
	return { score, scores: scoresFor(score) };
}

/** Seeds the high-credit org row the ledger gate needs (a huge balance keeps
 * consumption irrelevant to the properties under test). No-op for org-less
 * channels. Shared by every property so the fixture lives once. */
export async function seedOrgFor(orgId: string | null): Promise<void> {
	if (orgId === null) return;
	await testDb().db.insert(organizations).values({
		id: orgId,
		name: `Org ${orgId}`,
		creditsRemaining: 1_000_000
	});
}

/** Seeds the generated channel row (no toneLevel unless given — the default
 * means no tone pass, no video metadata call). A channel carrying an orgId
 * needs its org row: the ledger gates AI scoring on the balance and fails
 * loudly for a missing org (never a silent "no credits"). */
export async function seedChannel(channel: ChannelRow, toneLevel?: number): Promise<void> {
	await testDb().db.insert(channels).values({
		id: channel.id,
		userId: channel.userId,
		orgId: channel.orgId,
		title: channel.title,
		refreshTokenEnc: channel.refreshTokenEnc,
		...(toneLevel === undefined ? {} : { toneLevel })
	});
	await seedOrgFor(channel.orgId);
}

/** Sorts rows by a projection — the order-insensitive comparator all the
 * snapshot oracles use. */
export function by<T>(rows: T[], key: (row: T) => string | number): T[] {
	return [...rows].sort((x, y) => {
		const kx = key(x);
		const ky = key(y);
		return kx < ky ? -1 : kx > ky ? 1 : 0;
	});
}

/** Reads one channel row, failing loudly when absent. */
export async function channelRow(channelId: string) {
	const row = await testDb().db.select().from(channels).where(eq(channels.id, channelId)).get();
	if (!row) throw new Error(`channel ${channelId} missing from the test database`);
	return row;
}
