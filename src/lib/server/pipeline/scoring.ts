// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; see LICENSE.

import { eq, inArray } from 'drizzle-orm';
import { loadHandleSet } from '$lib/server/allowlist';
import { getCredits, orgIsMetered } from '$lib/server/billing/ledger';
import { db } from '$lib/server/db';
import { comments, rules } from '$lib/server/db/schema';
import { DeadlineExceededError } from '$lib/server/http';
import { prepareRules } from '$lib/server/rules';
import type { ToneProtections } from '$lib/server/tone';
import { fetchVideoMetadata, type CommentPage } from '$lib/server/youtube';
import { aiUnavailable, decide } from './decisions';
import type { Decision, DecisionBatch, DecisionBatchOptions, ScoreOutcome } from './types';

/**
 * Fetches video titles/descriptions for level-2 tone scoring. Best-effort:
 * a videos.list failure (or missing metadata) scores comments with empty
 * context; the tone pass falling back to the human queue is I11, never a
 * batch abort (DeadlineExceededError still escapes).
 */
export async function loadVideoContext(
	toneEnabled: boolean,
	newComments: Array<CommentPage['comments'][number]>,
	accessToken: string,
	deadline: number | undefined
): Promise<{ videoContext: Awaited<ReturnType<typeof fetchVideoMetadata>> | null; metadataError: unknown }> {
	let videoContext: Awaited<ReturnType<typeof fetchVideoMetadata>> | null = null;
	let metadataError: unknown = null;
	if (toneEnabled && newComments.length) {
		videoContext = new Map();
		const videoIds = [...new Set(newComments.map((comment) => comment.videoId).filter((id): id is string => id !== null))];
		if (videoIds.length) {
			try {
				videoContext = await fetchVideoMetadata(videoIds, accessToken, deadline);
			} catch (error) {
				if (error instanceof DeadlineExceededError) throw error;
				metadataError = error;
			}
		}
	}
	return { videoContext, metadataError };
}

export async function prepareDecisionBatch(
	channelId: string,
	page: CommentPage,
	options: DecisionBatchOptions
): Promise<{
	newComments: Array<CommentPage['comments'][number]>;
	rulesForChannel: ReturnType<typeof prepareRules>;
	allowlist: Awaited<ReturnType<typeof loadHandleSet>>;
	aiBudget: { remaining: number };
	videoContext: Awaited<ReturnType<typeof fetchVideoMetadata>> | null;
	metadataError: unknown;
}> {
// Credits gate AI scoring for live runs only (I8: a dry run changes nothing
// durable) — and only for METERED orgs. An org that never engaged billing
// (NULL balance, no Stripe customer) is unmetered: self-hosted and
// lifetime-plan orgs score unlimited (the free tier is self-hosted only).
// Consumption for an unmetered org is naturally a no-op (consumeCredit's
// NULL-balance guard rejects the charge), so the gate is the whole story.
// Orphan channels (no org) predate the billing model — they score until
// claimed (infinite budget). The budget is the org's balance: each AI
// decision claims one credit of it, so an org with N credits scores at
// most N AI comments per batch — the rest defer for a post-top-up retry.
let metered = false;
if (options.consumeCredits && options.orgId) {
	metered = await orgIsMetered(options.orgId);
}
const aiBudget = {
	remaining: metered && options.orgId ? await getCredits(options.orgId) : Number.POSITIVE_INFINITY
};
// Dry-run window mode (rescore: true) skips the stored-IDs dedupe entirely:
// re-scoring comments a real run already moderated is the point of the
// preview. The within-batch dedupe below still applies. The DB query is
// skipped in both no-consult cases (rescore, empty page).
// Stryker disable ArrayDeclaration: equivalent — with an empty page there are no comments to consult existingIds for, so its contents are never read
const storedIds =
	!options.rescore && page.comments.length
		? (
				await db
					.select({ id: comments.id })
					.from(comments)
					.where(inArray(comments.id, page.comments.map((comment) => comment.id)))
					.all()
			).map((comment) => comment.id)
		: [];
// Stryker restore ArrayDeclaration
const existingIds = new Set(storedIds);
const rulesForChannel = prepareRules(await db.select().from(rules).where(eq(rules.channelId, channelId)).all());
// One allowlist read per run; decide() checks it before any rule or scoring.
const allowlist = await loadHandleSet(channelId);
// Dedupe twice: against already-stored comments AND within this batch.
// commentThreads pagination can repeat an item across page boundaries, and
// two decisions with one comment id would violate the comments.id PRIMARY
// KEY, failing the entire staging transaction (I1: one bad item never
// aborts the batch).
const seen = new Set<string>();
const newComments = page.comments.filter((comment) => {
	if (existingIds.has(comment.id) || seen.has(comment.id)) return false;
	seen.add(comment.id);
	return true;
});
// A ticked protection flag forces the tone pass on even below level 2: the
// channel owner asked for heightened scrutiny, so the checkbox must never
// be a silent no-op.
const toneEnabled =
	options.toneLevel >= 2 || Boolean(options.protections.protectLgbtqia) || Boolean(options.protections.protectWomen);
const { videoContext, metadataError } = await loadVideoContext(
	toneEnabled,
	newComments,
	options.accessToken,
	options.deadline
);
return { newComments, rulesForChannel, allowlist, aiBudget, videoContext, metadataError };
}
export async function scoreComments(
	newComments: Array<CommentPage['comments'][number]>,
	options: {
		rulesForChannel: ReturnType<typeof prepareRules>;
		allowlist: Awaited<ReturnType<typeof loadHandleSet>>;
		aiBudget: { remaining: number };
		videoContext: Awaited<ReturnType<typeof fetchVideoMetadata>> | null;
		metadataError: unknown;
		deadline: number | undefined;
		protections: ToneProtections;
		openAiKey: string | undefined;
	}
): Promise<ScoreOutcome[]> {
	const { rulesForChannel, allowlist, aiBudget, videoContext, metadataError, deadline, protections, openAiKey } = options;
const settled = await Promise.allSettled(
	newComments.map(async (comment) => {
		try {
			if (metadataError) return aiUnavailable(comment, metadataError);
			// Stryker disable next-line ConditionalExpression: equivalent — for a null videoId both branches yield undefined (Map.get(null) misses), and a non-null id takes the false branch anyway
			const meta = comment.videoId === null ? undefined : videoContext?.get(comment.videoId);
			const tone = videoContext
				? { context: { videoTitle: meta?.title ?? '', videoDescription: meta?.description ?? '' } }
				: null;
			return await decide(comment, rulesForChannel, allowlist, tone, aiBudget, { deadline, protections, openAiKey });
		} catch (error) {
			// DeadlineExceededError escapes decide() by design (aiDecision
			// rethrows it) so the run aborts partial:true with no durable
			// writes — pinned by the omni/tone deadline-scoring tests.
			if (error instanceof DeadlineExceededError) throw error;
			throw new Error(`comment ${comment.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	})
);

	return settled;
}
export function foldDecisions(settled: ScoreOutcome[]): { decisions: Decision[]; failures: string[]; deferred: number } {
const decisions: Decision[] = [];
const failures: string[] = [];
let deferred = 0;
for (const result of settled) {
	if (result.status === 'fulfilled') {
		// Deferred decisions are never staged: they stay unprocessed so a
		// later run (after a top-up) re-fetches and scores them.
		if (result.value.deferred) {
			deferred += 1;
			continue;
		}
		decisions.push(result.value);
		continue;
	}
	// A rejected promise whose reason is a DeadlineExceededError (rethrown
	// from aiDecision via the wrapper above) aborts the whole batch.
	if (result.reason instanceof DeadlineExceededError) throw result.reason;
	failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
}
return { decisions, failures, deferred };
}
export async function decideNewComments(
	channelId: string,
	page: CommentPage,
	{
		accessToken,
		toneLevel,
		protections,
		openAiKey,
		deadline,
		rescore,
		orgId,
		consumeCredits
	}: DecisionBatchOptions
): Promise<{ decisions: Decision[]; failures: string[]; deferred: number }> {
	const batch = await prepareDecisionBatch(channelId, page, {
		accessToken,
		toneLevel,
		protections,
		openAiKey,
		deadline,
		rescore,
		orgId,
		consumeCredits
	});
	const settled = await scoreComments(batch.newComments, {
		rulesForChannel: batch.rulesForChannel,
		allowlist: batch.allowlist,
		aiBudget: batch.aiBudget,
		videoContext: batch.videoContext,
		metadataError: batch.metadataError,
		deadline,
		protections,
		openAiKey
	});
	return foldDecisions(settled);
}
