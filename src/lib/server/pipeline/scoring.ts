import { and, eq, inArray } from 'drizzle-orm';
import { loadProtectedIdentities } from '$lib/server/allowlist';
import { getCredits, orgIsMetered } from '$lib/server/billing/ledger';
import { db } from '$lib/server/db';
import { comments, rules } from '$lib/server/db/schema';
import { DeadlineExceededError } from '$lib/server/http';
import { prepareRules } from '$lib/server/rules';
import type { ToneProtections } from '$lib/server/tone';
import { TONE_LEVEL_OMNI_AND_TONE } from '$lib/toneLevels';
import { fetchVideoMetadata, fetchAuthorHandles, resolveHandleChannelId, type CommentPage } from '$lib/server/youtube';
import { decide, metadataUnavailable } from './decisions';
import { hasHumanClaim } from './human-claims';
import type { AiBudget, Decision, DecisionBatchOptions, ScoreOutcome } from './types';

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
				videoContext = null;
			}
		}
	}
	return { videoContext, metadataError };
}

/** One page-scoped read excludes prior scan visits and current human claims
 * before enrichment and AI budget consumption. Staging rechecks protection
 * inside its write transaction and stamps still-protected visits. */
async function loadRescanExclusions(
	channelId: string,
	pageComments: CommentPage['comments'],
	scanStamp: string | null | undefined
): Promise<{ stagedIds: Set<string>; protectedIds: string[] }> {
	const rows = await db.select({ id: comments.id, scanId: comments.scanId, status: comments.status, humanDispatchToken: comments.humanDispatchToken, humanDispatchState: comments.humanDispatchState })
		.from(comments).where(and(eq(comments.channelId, channelId), inArray(comments.id, pageComments.map(comment => comment.id)))).all();
	return {
		stagedIds: new Set(rows.filter(row => scanStamp != null && row.scanId === scanStamp).map(row => row.id)),
		protectedIds: rows.filter(hasHumanClaim).map(row => row.id)
	};
}

async function loadAuthorHandles(
	newComments: CommentPage['comments'],
	accessToken: string,
	deadline: number | undefined
): Promise<{ handles: Map<string, string>; handleLookupError: boolean }> {
	let handles = new Map<string, string>();
	let handleLookupError = false;
	try {
		handles = await fetchAuthorHandles(newComments.map(comment => comment.authorChannelId), accessToken, deadline);
	} catch (error) {
		if (error instanceof DeadlineExceededError) throw error;
		console.warn('YouTube author-handle lookup failed; continuing without audit handles', error);
		handleLookupError = true;
	}
	return { handles, handleLookupError };
}

export async function prepareDecisionBatch(
	channelId: string,
	page: CommentPage,
	options: DecisionBatchOptions
): Promise<{
	newComments: Array<CommentPage['comments'][number]>;
	rulesForChannel: ReturnType<typeof prepareRules>;
	allowlist: Awaited<ReturnType<typeof loadProtectedIdentities>>;
	aiBudget: AiBudget;
	videoContext: Awaited<ReturnType<typeof fetchVideoMetadata>> | null;
	metadataError: unknown;
	handleLookupError: boolean;
	protectedIds: string[];
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
const aiBudget: AiBudget = {
	remaining: metered && options.orgId ? await getCredits(options.orgId) : Number.POSITIVE_INFINITY
};
// A live rescan skips committed visits and pending/active/uncertain human
// claims. Dry-run previews deliberately score the original page without
// changing reservations or scan markers.
const { stagedIds, protectedIds } =
	options.rescore && options.consumeCredits && page.comments.length
		? await loadRescanExclusions(channelId, page.comments, options.scanStamp)
		: { stagedIds: new Set<string>(), protectedIds: [] };
const protectedIdSet = new Set(protectedIds);
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
// Dedupe three ways: against already-stored comments, within this batch,
// and against comments this scan already staged (the scan_id marker). The
// last keeps a parked rescan page from re-scoring finished work every tick;
// staged comments' committed action rows still drain via enforcement.
// commentThreads pagination can repeat an item across page boundaries, and
// two decisions with one comment id would violate the comments.id PRIMARY
// KEY, failing the entire staging transaction (I1: one bad item never
// aborts the batch).
const seen = new Set<string>();
const newComments = page.comments.filter((comment) => {
	if (existingIds.has(comment.id) || seen.has(comment.id) || stagedIds.has(comment.id) || protectedIdSet.has(comment.id)) return false;
	seen.add(comment.id);
	return true;
});
// Idle/already-staged pages need configuration only. Pending destructive
// actions independently resolve protection in enforcement when necessary.
const allowlist = await loadProtectedIdentities(channelId, db, newComments.length
	? handle => resolveHandleChannelId(handle, options.accessToken, options.deadline)
	: undefined);
const { handles, handleLookupError } = await loadAuthorHandles(newComments, options.accessToken, options.deadline);
for (const comment of newComments) comment.authorHandle = handles.get(comment.authorChannelId) ?? null;
// A ticked protection flag forces the tone pass on even below
// TONE_LEVEL_OMNI_AND_TONE: the channel owner asked for heightened scrutiny,
// so the checkbox must never be a silent no-op.
const toneEnabled =
	options.toneLevel >= TONE_LEVEL_OMNI_AND_TONE || Boolean(options.protections.protectLgbtqia) || Boolean(options.protections.protectWomen);
const { videoContext, metadataError } = await loadVideoContext(
	toneEnabled,
	newComments,
	options.accessToken,
	options.deadline
);
return { newComments, rulesForChannel, allowlist, aiBudget, videoContext, metadataError, handleLookupError, protectedIds };
}
export async function scoreComments(
	newComments: Array<CommentPage['comments'][number]>,
	options: {
		rulesForChannel: ReturnType<typeof prepareRules>;
		allowlist: Awaited<ReturnType<typeof loadProtectedIdentities>>;
		aiBudget: AiBudget;
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
			// Video metadata is required only for tone context. Preserve the
			// allowlist/rule precedence, then queue unresolved comments loudly;
			// do not spend an AI credit when the enrichment call failed.
			if (metadataError) return metadataUnavailable(comment, rulesForChannel, allowlist, metadataError);
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
		scanStamp,
		consumeCredits
	}: DecisionBatchOptions
): Promise<{ decisions: Decision[]; failures: string[]; deferred: number; protectedIds: string[]; handleLookupError: boolean; protection: Awaited<ReturnType<typeof loadProtectedIdentities>> }> {
	const batch = await prepareDecisionBatch(channelId, page, {
		accessToken,
		toneLevel,
		protections,
		openAiKey,
		deadline,
		rescore,
		orgId,
		scanStamp,
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
	return { ...foldDecisions(settled), protectedIds: batch.protectedIds, handleLookupError: batch.handleLookupError, protection: batch.allowlist };
}
