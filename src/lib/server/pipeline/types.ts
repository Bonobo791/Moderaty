// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; see LICENSE.

import type { loadHandleSet } from '$lib/server/allowlist';
import type { moderationActions } from '$lib/server/db/schema';
import type { prepareRules } from '$lib/server/rules';
import type { CommentPage, NewComment, fetchVideoMetadata } from '$lib/server/youtube';
import type { ToneContext, ToneProtections } from '$lib/server/tone';

export interface RunChannelOptions {
	maxPages?: number;
	deadline?: number;
	/** On-demand preview (dashboard button): forces dry-run semantics for this
	 * call. Can only turn dry-run ON — an env-dry deployment is never flipped
	 * live by a caller. */
	forceDryRun?: boolean;
	/** Dry-run drain over a time window: fetch one page bounded by `boundary`
	 * (ignoring the live cursor/checkpoint) and rescore even comments stored by
	 * real runs — re-scoring them is the point of the preview. Only meaningful
	 * with forceDryRun. The caller persists any continuation state. */
	window?: { boundary: string; pageToken: string | null };
}

export interface ChannelRunResult {
	fetched: number;
	acted: number;
	queued: number;
	partial: boolean;
	skipped: boolean;
	dryRun: boolean;
	/** Window-mode continuation: token for the next drain page (null when the
	 * window is exhausted) and whether the drain reached its boundary. Absent
	 * outside window mode. */
	windowNextPageToken?: string | null;
	windowComplete?: boolean;
	/** True when AI scoring was paused mid-run because the org's credit balance
	 * hit zero: rule/allowlist decisions still staged, AI-dependent comments
	 * deferred, the cursor parked so they are retried after a top-up. */
	outOfCredits?: boolean;
}

export interface Decision {
	comment: NewComment;
	status: string;
	decidedBy: string;
	matchedRuleId: number | null;
	aiScore: string | null;
	auditAction: string | null;
	reason: string | null;
	youtubeAction: 'hold' | 'reject' | 'delete' | 'ban' | null;
	/** Out-of-credits marker: AI scoring was skipped for this comment. Deferred
	 * decisions are never staged — they stay unprocessed so a later run (after
	 * a top-up) re-fetches and scores them. */
	deferred?: boolean;
	/** True when this decision consumed AI budget — the ONLY decisions that
	 * may be charged a credit. Rule/allowlist decisions never reach AI and
	 * must stage free (the marker is set where the budget is decremented
	 * (decide), so a decision that never claimed budget (e.g. the metadataError
	 * queue path) can never be billed. */
	billable?: boolean;
}

export type YoutubeAction = Exclude<Decision['youtubeAction'], null>;

export type OutstandingAction = typeof moderationActions.$inferSelect & {
	action: YoutubeAction;
	state: 'pending' | 'dispatched';
};

export interface AiOptions {
	deadline: number | undefined;
	protections: ToneProtections;
	openAiKey: string | undefined;
}

export type DecisionBatchOptions = {
	accessToken: string;
	toneLevel: number;
	protections: ToneProtections;
	openAiKey?: string;
	deadline?: number;
	rescore?: boolean;
	orgId?: string | null;
	/** True for live runs: credits gate AI scoring and consumption applies.
	 * Dry runs (previews, window rescore) always score and never consume. */
	consumeCredits?: boolean;
};

export type ScoreOutcome = PromiseSettledResult<Decision>;

export type DecisionBatch = {
	newComments: Array<CommentPage['comments'][number]>;
	rulesForChannel: ReturnType<typeof prepareRules>;
	allowlist: Awaited<ReturnType<typeof loadHandleSet>>;
	aiBudget: { remaining: number };
	videoContext: Awaited<ReturnType<typeof fetchVideoMetadata>> | null;
	metadataError: unknown;
};

export type ToneDecisionContext = { context: ToneContext } | null;
