import type { loadProtectedIdentities } from '$lib/server/allowlist';
import type { DryRunClaim } from '$lib/server/dryRun';
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
	/** Dashboard-preview claim binding (cubic): when set, the loaded channel
	 * row must still carry this fingerprint — org, connector ciphertext, and
	 * the claim's lease. A delete/reconnect lands the same channel id on a
	 * fresh row; without the check the preview would run against a channel
	 * that never claimed the allowance. */
	claim?: DryRunClaim;
}

export interface ChannelRunResult {
	fetched: number;
	acted: number;
	queued: number;
	partial: boolean;
	skipped: boolean;
	dryRun: boolean;
	/** Why a partial run stopped early: 'deadline' means the check timed out
	 * (a failed-check verdict); 'deactivated' means the channel was paused
	 * mid-run (no verdict — the Paused badge covers it). Absent on complete
	 * runs and on results produced before this field existed. */
	stoppedReason?: 'deadline' | 'deactivated';
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
	// 'cancelling': a rescan verdict cancelled this intent after dispatch —
	// the next sweep converges the remote state (re-writing the comment's
	// decided status when the cancelled action may have landed) before
	// superseding it (codex/cubic).
	state: 'pending' | 'dispatched' | 'cancelling';
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
	/** The active rescan's staging marker — the value the upsert stamps on
	 * comments.scan_id (the scan nonce; a pre-nonce drain falls back to its
	 * planted boundary so it still marks its own work). Rows stamped with it
	 * are skipped on the next page fetch: they were already decided+staged
	 * by this scan, so a parked page or a crash retry must not re-score them
	 * or re-pend their action rows. Billing-independent — it covers
	 * rule/allowlist and unmetered verdicts that mint no credit anchor
	 * (codex). Absent on non-rescan runs. */
	scanStamp?: string | null;
	/** True for live runs: credits gate AI scoring and consumption applies.
	 * Dry runs (previews, window rescore) always score and never consume. */
	consumeCredits?: boolean;
};

export type AiBudget = {
	remaining: number;
};

export type ScoreOutcome = PromiseSettledResult<Decision>;

export type DecisionBatch = {
	newComments: Array<CommentPage['comments'][number]>;
	rulesForChannel: ReturnType<typeof prepareRules>;
	allowlist: Awaited<ReturnType<typeof loadProtectedIdentities>>;
	aiBudget: AiBudget;
	videoContext: Awaited<ReturnType<typeof fetchVideoMetadata>> | null;
	metadataError: unknown;
};

/** Rescan staging mode: stored rows upsert to the fresh verdict and action
 * rows re-pend/supersede. chargeScope is the scan's per-request nonce; null is
 * a drain planted before the nonce column existed — it still upserts but
 * keeps charging the plain comment id its earlier pages anchored (codex).
 * scanStamp is what the upsert writes to comments.scan_id — the nonce, or the
 * drain's planted boundary when no nonce exists, so every drain marks its own
 * staged rows and a retry/parked tick can skip them. */
export type RescanCharge = { chargeScope?: string | null; scanStamp?: string | null };

export type ToneDecisionContext = { context: ToneContext } | null;
