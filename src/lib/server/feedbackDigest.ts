// Digest generation job (MOD-90): bounded cron rotation, per-channel
// cadence, credit metering, and all-or-nothing persistence. Metered orgs
// are charged up front in one transaction — before any provider call —
// anchored per comment so a crashed run retries without double-charging;
// a shortfall defers with the balance untouched. The write transaction
// then commits digest + findings + evidence + the per-comment digest
// markers + the rotation stamp together, or not at all — never a partial
// digest. Per-comment classifier failures are counted and skipped (I1);
// a job-level failure records a 'failed' row and a deferral a 'deferred'
// row so the page can say so instead of silently showing stale data —
// both are transient state a terminal outcome clears.

import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, withBusyRetry } from '$lib/server/db';
import { channels, comments, feedbackDigests, feedbackFindings, feedbackHistoryComments, findingEvidence } from '$lib/server/db/schema';
import { classifyFeedback, type FeedbackCategory } from '$lib/server/feedback';
import { fetchFeedbackPage, pendingStoredFeedback, advanceFeedbackHistory, type FeedbackHistoryPage } from '$lib/server/feedbackHistory';
import { concealEvidence } from '$lib/server/feedbackSanitize';
import { clusterClassifiedClaims } from '$lib/server/feedbackCluster';
import { groupFeedback } from '$lib/server/feedbackGroup';
import { DeadlineExceededError, assertBeforeDeadline } from '$lib/server/http';
import { consumeCreditsBulk, orgIsMetered, type LedgerHandle } from '$lib/server/billing/ledger';
import { channelMatchesClaim, type DryRunClaim } from '$lib/server/dryRun';
import { resolveOpenAiKey } from '$lib/server/openaiKey';

/** One page of stored comments per run — the same bound moderation uses (I10). */
export const DIGEST_COMMENT_CAP = 100;

/** Evidence excerpts are capped like audit_log.text — long comments store the same 500 chars. */
const EXCERPT_MAX = 500;

/**
 * Reserved headroom before the write transaction: a full batch runs
 * hundreds of sequential statements against the remote database, so
 * entering the tx with the deadline already spent risks a mid-write kill —
 * the run defers instead and retries with markers untouched (codex).
 */
const WRITE_RESERVE_MS = 5_000;

/** Weekly cadence: a channel is due again 7 days after its last evaluation. */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** 'per_100' cadence: due once ≥100 comments are still unprocessed (marker NULL). */
export const PER_100_COUNT = 100;

const EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * Digest rows that are ATTEMPT STATE a resolved run supersedes. Preview rows
 * are deliberately absent: 'dry-run' is a permanent feed entry,
 * 'dry-run-pending' is the drainer's resume record (I3), and 'dry-run-failed'
 * is the terminal preview failure — none may be deleted or reused as a
 * digest run's window anchor, so the set is exported for the feed's own
 * attempt/history queries to share.
 */
export const TRANSIENT_DIGEST_STATUSES = ['failed', 'deferred'] as const;

/** A metered org ran out of feedback credits mid-charge — a distinct class so
 * the run's catch matches the type instead of regex-sniffing message text. */
class InsufficientCreditsError extends Error {
	constructor() {
		super('insufficient credits for feedback digest');
	}
}
const ERR_PREVIEW_PAUSED = 'channel is paused';
const ERR_PREVIEW_NO_KEY = 'no OpenAI key resolved for feedback preview';

export type DigestStatus = 'complete' | 'empty' | 'deferred' | 'skipped' | 'failed' | 'dry-run';

export interface DigestResult {
	status: DigestStatus;
	/** Why a non-complete run stopped — 'disabled' | 'inactive' | 'cadence' | 'credits' | 'no-key' | 'deadline' | failure category. */
	reason?: string;
	digestId?: number;
	commentsClassified?: number;
	commentsFailed?: number;
	clusteringDegraded?: boolean;
	findings?: number;
	pooled?: number;
	creditsUsed?: number;
	historyRemaining?: boolean;
}

export interface DigestOptions {
	deadline?: number;
	/** Dashboard "generate now" bypasses the cadence check; cron ticks use it. */
	force?: boolean;
	/** Dry runs never write digest rows (I8) — same guarantee as runChannel. */
	forceDryRun?: boolean;
}

interface ClassifiedRow {
	commentId: string;
	text: string;
	publishedAt: string;
	category: FeedbackCategory;
	hasAbuse: boolean;
	claim: string;
}

async function classifyBatch(
	batch: { id: string; text: string; publishedAt: string }[],
	deadline: number | undefined,
	apiKey: string
): Promise<{ classified: ClassifiedRow[]; failed: number }> {
	const settled = await Promise.allSettled(
		batch.map((comment) =>
			classifyFeedback(comment.text, { videoTitle: '', videoDescription: '' }, deadline, apiKey)
		)
	);
	const classified: ClassifiedRow[] = [];
	let failed = 0;
	for (let i = 0; i < settled.length; i++) {
		const outcome = settled[i];
		if (outcome.status === 'rejected') {
			// A deadline aborts the whole run — the tick defers cleanly and
			// retries the same comments (markers never moved); anything
			// else is a bad ITEM (I1): count it, log it, keep going.
			if (outcome.reason instanceof DeadlineExceededError) throw outcome.reason;
			failed++;
			console.error('feedback classification failed for comment:', batch[i].id, outcome.reason);
			continue;
		}
		classified.push({ commentId: batch[i].id, text: batch[i].text, publishedAt: batch[i].publishedAt, ...outcome.value });
	}
	return { classified, failed };
}

/**
 * Compares stored ISO timestamps by INSTANT, not text: publishedAt is stored
 * verbatim from YouTube and the data model permits any parseable offset
 * ('+05:30' sorts differently as text than as a moment). julianday returns
 * NULL on garbage, which fails the predicate loudly rather than silently
 * including a malformed row (I2).
 */
const instant = (column: typeof comments.publishedAt | typeof feedbackDigests.windowEnd) => sql`julianday(${column})`;

/**
 * The digest row's windowStart label resumes where the last COMPLETE digest
 * ended — display metadata only. Coverage is tracked by the per-comment
 * feedback_digested_at marker, not this edge, so a failed run losing the
 * row or a backfilled comment can't distort what's processed.
 */
async function lastWindowEnd(channelId: string): Promise<string> {
	const row = await db
		.select({ windowEnd: feedbackDigests.windowEnd })
		.from(feedbackDigests)
		.where(and(eq(feedbackDigests.channelId, channelId), eq(feedbackDigests.status, 'complete')))
		.orderBy(desc(instant(feedbackDigests.windowEnd)))
		.limit(1)
		.get();
	return row?.windowEnd ?? EPOCH;
}

/** Parses the channel's category mask; null/absent means all four categories. */
export function enabledCategories(channel: typeof channels.$inferSelect): FeedbackCategory[] {
	if (!channel.feedbackCategories) return ['question', 'criticism', 'correction', 'request'];
	const enabled = channel.feedbackCategories
		.split(',')
		.filter((c): c is FeedbackCategory =>
			c === 'question' || c === 'criticism' || c === 'correction' || c === 'request'
		);
	return enabled;
}

/**
 * Whether the AI theme pass can change this batch's outcome. A finding
 * requires `threshold` supporters in one enabled category, so when no
 * enabled category already reaches it, grouping pools every row regardless
 * of how claims merge — the provider call would be wasted spend, and its
 * failure would defer a run whose result is already determined (codex).
 */
function themePassCanMatter(
	classified: { category: FeedbackCategory }[],
	categories: FeedbackCategory[],
	threshold: number
): boolean {
	const enabled = new Set<string>(categories);
	const counts = new Map<string, number>();
	for (const row of classified) {
		if (!enabled.has(row.category)) continue;
		const n = (counts.get(row.category) ?? 0) + 1;
		counts.set(row.category, n);
		if (n >= threshold) return true;
	}
	return false;
}

/**
 * Is this channel's digest due right now?
 * - manual: never auto — the dashboard's "generate now" passes force.
 * - per_100: ≥100 stored comments still carry a NULL digest marker.
 * - weekly (default + unknown values, loudly): last evaluation ≥ 7 days ago.
 */
export async function digestDue(channel: typeof channels.$inferSelect, now?: number): Promise<boolean> {
	if (channel.feedbackHistoryBoundary) return true;
	const cadence = channel.feedbackCadence ?? 'weekly';
	if (cadence === 'manual') return false;
	if (cadence === 'per_100') {
		// Unprocessed is the marker, not a timestamp — a backfilled comment
		// with an old publishedAt counts the same as a fresh one.
		const row = await db
			.select({ n: sql<number>`COUNT(*)` })
			.from(comments)
			.where(pendingStoredFeedback(channel.id))
			.get();
		return (row?.n ?? 0) >= PER_100_COUNT;
	}
	if (cadence !== 'weekly') {
		console.error(`channel ${channel.id} has unknown feedback cadence "${cadence}" — treating as weekly`);
	}
	if (!channel.feedbackLastDigestAt) return true;
	return Date.parse(channel.feedbackLastDigestAt) + WEEK_MS <= (now ?? Date.now());
}

/**
 * Deletes a channel's TRANSIENT rows ('failed'/'deferred') — attempt state
 * any fresh outcome supersedes, at ANY window — with their findings
 * children. 'complete' rows are untouched: a complete row at the same
 * window is a DIFFERENT capped batch (coverage lives in the per-comment
 * markers, so a re-run of the same comments is impossible): deleting it
 * would silently drop a processed batch from history (codex). Preview rows
 * ('dry-run'/'dry-run-pending') are likewise permanent/lifecycle state —
 * a digest run must never delete them (MOD-229).
 */
async function clearTransientDigests(tx: LedgerHandle, channelId: string): Promise<void> {
	const existing = await tx
		.select({ id: feedbackDigests.id })
		.from(feedbackDigests)
		.where(and(eq(feedbackDigests.channelId, channelId), inArray(feedbackDigests.status, TRANSIENT_DIGEST_STATUSES)))
		.all();
	if (!existing.length) return;
	const digestIds = existing.map((d) => d.id);
	const findingIds = (
		await tx
			.select({ id: feedbackFindings.id })
			.from(feedbackFindings)
			.where(inArray(feedbackFindings.digestId, digestIds))
			.all()
	).map((f) => f.id);
	if (findingIds.length) {
		await tx.delete(findingEvidence).where(inArray(findingEvidence.findingId, findingIds));
	}
	await tx.delete(feedbackFindings).where(inArray(feedbackFindings.digestId, digestIds));
	await tx.delete(feedbackDigests).where(inArray(feedbackDigests.id, digestIds));
}

/** Records a transient non-complete row (failed/deferred), superseding all earlier attempt state. */
async function markDigestState(
	channelId: string,
	windowStart: string,
	windowEnd: string,
	status: 'failed' | 'deferred',
	reason: string,
	expected?: typeof channels.$inferSelect
): Promise<void> {
	try {
		await db.transaction(async (tx) => {
			// A channel deleted mid-run gets no posthumous rows — the
			// existence check mirrors the stamp guard in the main write.
			const guards = expected
				? [
						expected.orgId === null ? isNull(channels.orgId) : eq(channels.orgId, expected.orgId),
						expected.leaseExpiresAt === null ? isNull(channels.leaseExpiresAt) : eq(channels.leaseExpiresAt, expected.leaseExpiresAt),
						expected.feedbackHistoryBoundary === null
							? isNull(channels.feedbackHistoryBoundary)
							: eq(channels.feedbackHistoryBoundary, expected.feedbackHistoryBoundary),
						expected.feedbackHistoryPageToken === null
							? isNull(channels.feedbackHistoryPageToken)
							: eq(channels.feedbackHistoryPageToken, expected.feedbackHistoryPageToken),
						// Two scans can share boundary+token — the nonce is the
						// scan's identity: a stale attempt's status row must not
						// write under a scan that isn't its own.
						expected.feedbackHistoryScanId === null
							? isNull(channels.feedbackHistoryScanId)
							: eq(channels.feedbackHistoryScanId, expected.feedbackHistoryScanId)
					]
				: [];
			const alive = await tx
				.select({ id: channels.id })
				.from(channels)
				.where(and(eq(channels.id, channelId), ...guards))
				.get();
			if (!alive) throw new Error(`channel ${channelId} vanished — skipping ${status} record`);
			// Reuse the newest transient row's window as the anchor: a retry
			// overwrites the same row instead of stacking a fresh-windowed row
			// per attempt, which accumulated one orphan per tick (codex+cubic).
			const prior = await tx
				.select({ windowStart: feedbackDigests.windowStart, windowEnd: feedbackDigests.windowEnd })
				.from(feedbackDigests)
				.where(and(eq(feedbackDigests.channelId, channelId), inArray(feedbackDigests.status, TRANSIENT_DIGEST_STATUSES)))
				.orderBy(desc(feedbackDigests.id))
				.get();
			await clearTransientDigests(tx, channelId);
			await tx.insert(feedbackDigests).values({
				channelId,
				windowStart: prior?.windowStart ?? windowStart,
				windowEnd: prior?.windowEnd ?? windowEnd,
				status,
				error: reason
			});
		});
	} catch (cause) {
		// The status row itself failed to write — log loudly; the next tick
		// retries the same window (it never advanced).
		console.error('could not record digest %s for channel %s:', status, channelId, cause);
	}
}

/** The batch one digest run will classify, plus its display window and rescan context. */
interface SelectedBatch {
	batch: { id: string; text: string; publishedAt: string }[];
	windowStart: string;
	windowEnd: string;
	/** Set only in history-rescan mode — the fetched page this batch came from. */
	historyPage?: FeedbackHistoryPage;
	/** The scan nonce qualifying this run's charge anchors; absent on legacy pre-nonce drains. */
	historyScanScope?: string;
}

/**
 * The ids in this history page the run must NOT reprocess. Legacy drains
 * (NULL scan id) keep the OLD coverage semantics — every digested or
 * history-sourced row stays covered — while a nonce'd scan dedupes only
 * against its own committed rows, so other scans' comments reprocess.
 */
async function historyCoveredIds(
	channel: typeof channels.$inferSelect,
	channelId: string,
	ids: string[]
): Promise<Set<string>> {
	if (channel.feedbackHistoryScanId === null) {
		// A drain planted before the nonce column existed resumes under
		// the OLD coverage semantics: the owner never asked for a repeat
		// scan, so comments already digested by the stored path or
		// already history-sourced stay covered — reprocessing them would
		// mint duplicate findings and provider calls their legacy plain
		// anchors can't even debit (codex). The all-rows history check
		// also catches this drain's own page-boundary repeats, whose
		// committed rows carry a NULL scan_id.
		const [digested, historical] = await Promise.all([
			db
				.select({ id: comments.id })
				.from(comments)
				.where(and(eq(comments.channelId, channelId), inArray(comments.id, ids), isNotNull(comments.feedbackDigestedAt)))
				.all(),
			db
				.select({ id: feedbackHistoryComments.id })
				.from(feedbackHistoryComments)
				.where(and(eq(feedbackHistoryComments.channelId, channelId), inArray(feedbackHistoryComments.id, ids)))
				.all()
		]);
		return new Set([...digested, ...historical].map((row) => row.id));
	}
	// Same-scan dedupe across pages: commentThreads can re-serve an
	// item at a page boundary, and a comment THIS scan already
	// committed must not re-enter the batch — its anchor blocks the
	// second debit, but the repeat still double-counts creditsUsed
	// and can mint a second digest's duplicate finding (codex). Rows
	// from other scans still reprocess — re-running the same window
	// is the point of the feature.
	return new Set(
		(
			await db
				.select({ id: feedbackHistoryComments.id })
				.from(feedbackHistoryComments)
				.where(
					and(
						eq(feedbackHistoryComments.channelId, channelId),
						inArray(feedbackHistoryComments.id, ids),
						eq(feedbackHistoryComments.scanId, channel.feedbackHistoryScanId)
					)
				)
				.all()
		).map((row) => row.id)
	);
}

/**
 * Selects the batch in HISTORY-RESCAN mode: the next page after the stored
 * boundary, minus what this scan already committed. Returns either the
 * batch to classify or an already-resolved outcome — 'deferred'/'failed'
 * when the page fetch or checkpoint write fails, 'empty' when nothing
 * uncovered remains.
 */
async function selectHistoryBatch(
	channel: typeof channels.$inferSelect,
	channelId: string,
	nowIso: string,
	deadline: number | undefined
): Promise<SelectedBatch | DigestResult> {
	const historyBoundary = channel.feedbackHistoryBoundary;
	if (!historyBoundary) throw new Error(`channel ${channelId} has no feedback history boundary`);
	// The scan id planted with the boundary is the history run's billing
	// scope: each requested analysis charges its own anchors, while retries
	// of the same run stay idempotent. A NULL scan id is a drain planted
	// before the nonce column existed — its earlier pages charged the plain
	// comment id, so the anchor must stay plain (never a boundary-derived
	// twin) or the retry debits the same work twice (codex).
	const historyScanScope = channel.feedbackHistoryScanId ?? undefined;
	const windowStart = historyBoundary;
	const windowEnd = nowIso;
	let page: FeedbackHistoryPage;
	try {
		// Already-analyzed comments are classified again on purpose: the
		// owner re-requested the window, and re-running over the same data
		// is the point of the feature.
		page = await fetchFeedbackPage(channel, historyBoundary, channel.feedbackHistoryPageToken, deadline);
	} catch (cause) {
		console.error('feedback history page fetch failed for channel:', channelId, cause);
		const deferred = cause instanceof DeadlineExceededError;
		await markDigestState(channelId, windowStart, windowEnd, deferred ? 'deferred' : 'failed', deferred ? 'deadline' : 'history-fetch', channel);
		return { status: deferred ? 'deferred' : 'failed', reason: deferred ? 'deadline' : 'history-fetch', historyRemaining: true };
	}
	let batch = page.batch;
	if (batch.length) {
		const covered = await historyCoveredIds(channel, channelId, batch.map((comment) => comment.id));
		batch = batch.filter((comment) => !covered.has(comment.id));
	}
	if (!batch.length) {
		try {
			await db.transaction(async (tx) => {
				await advanceFeedbackHistory(tx, channel, page);
				await clearTransientDigests(tx, channelId);
			});
		} catch (cause) {
			console.error('feedback history checkpoint failed for channel:', channelId, cause);
			await markDigestState(channelId, windowStart, windowEnd, 'failed', 'history-checkpoint', channel);
			return { status: 'failed', reason: 'history-checkpoint', historyRemaining: true };
		}
		return { status: 'empty', historyRemaining: !page.complete };
	}
	return {
		batch,
		windowStart: batch[0].publishedAt,
		windowEnd: batch.at(-1)!.publishedAt,
		historyPage: page,
		historyScanScope
	};
}

/**
 * Selects the batch in STORED-BACKLOG mode: every comment still carrying a
 * NULL digest marker, oldest first (I10). Returns the batch to classify, or
 * 'empty' after stamping the rotation when nothing is unprocessed.
 */
async function selectStoredBatch(channelId: string, nowIso: string): Promise<SelectedBatch | DigestResult> {
	// Coverage is the per-comment marker, not a publication-time window:
	// every comment with a NULL feedback_digested_at is eligible — including
	// Analyze-history backfills whose publishedAt predates earlier digests
	// and cap-boundary timestamp ties a window edge could never express
	// (codex+coderabbit). Oldest-first drain: a burst beyond the cap leaves
	// the newest comments for the next digest instead of silently
	// swallowing the oldest ones.
	const batch = await db
		.select({ id: comments.id, text: comments.text, publishedAt: comments.publishedAt })
		.from(comments)
		.where(pendingStoredFeedback(channelId))
		.orderBy(asc(instant(comments.publishedAt)), asc(comments.id))
		.limit(DIGEST_COMMENT_CAP)
		.all();
	if (!batch.length) {
		// Nothing unprocessed — stamp the evaluation so the weekly rotation
		// moves on; no digest row (the page's empty state already says it).
		await db
			.update(channels)
			.set({ feedbackLastDigestAt: nowIso })
			.where(eq(channels.id, channelId));
		return { status: 'empty' };
	}
	// The row's window is descriptive, not authoritative — coverage lives in
	// the markers. Resume the label where the last complete digest ended,
	// but a backfilled batch that predates it anchors on its own earliest
	// instant instead of writing an inverted window.
	const since = await lastWindowEnd(channelId);
	return {
		batch,
		// `<=` keeps Codacy's lizard parser honest — `identifier <` reads as a
		// generic-arguments open and desyncs its brace accounting.
		windowStart: Date.parse(since) <= Date.parse(batch[0].publishedAt) ? since : batch[0].publishedAt,
		windowEnd: batch.at(-1)!.publishedAt
	};
}

// Charge the whole batch BEFORE any provider call, in ONE transaction: the
// (org, 'feedback', commentId) anchor makes each charge idempotent — a run
// that crashed between charge and write retries classification without
// paying again. All-or-nothing, so a shortfall defers with the balance
// untouched; and because the money is committed before the LLM call, a
// second same-org channel can no longer race a read-only precheck into
// wasted provider spend (codex).
async function chargeFeedbackBatch(
	orgId: string,
	batch: { id: string }[],
	historyScanScope: string | undefined,
	deadline: number | undefined
): Promise<number> {
	let creditsCharged = 0;
	await db.transaction(async (tx) => {
		const refs = batch.map((comment) => historyScanScope ? `${comment.id}#${historyScanScope}` : comment.id);
		assertBeforeDeadline(deadline);
		const { charged, covered, uncharged, metered } = await consumeCreditsBulk(tx, orgId, 'feedback', refs);
		assertBeforeDeadline(deadline);
		// `metered` is the org state read in THIS transaction: a concurrent
		// lifetime-plan change reports uncharged refs without a shortfall —
		// the org is unmetered, so nothing is owed (cubic).
		if (uncharged.length && metered) throw new InsufficientCreditsError();
		creditsCharged = charged.length + covered.length;
	});
	return creditsCharged;
}

/** Everything the write transaction needs, resolved before it starts. */
interface DigestRun {
	channel: typeof channels.$inferSelect;
	channelId: string;
	nowIso: string;
	windowStart: string;
	windowEnd: string;
	batch: { id: string; text: string; publishedAt: string }[];
	batchIds: Set<string>;
	classified: ClassifiedRow[];
	failed: number;
	findings: ReturnType<typeof groupFeedback>['findings'];
	clusteringDegraded: boolean;
	pooled: number;
	metered: boolean;
	creditsCharged: number;
	historyPage?: FeedbackHistoryPage;
}

/**
 * Inserts one finding row per grouped theme plus its sanitized evidence rows
 * under the given digest, inside the caller's transaction. Every evidence
 * row pins the analyzed text on the row itself (sourceText): a later rescan
 * can refresh the shared snapshot, and a preview's comments may never be
 * stored anywhere else — the evidence row is the only guaranteed home of
 * the text the classifier saw.
 */
async function insertFindings(
	tx: LedgerHandle,
	digestId: number,
	findings: DigestRun['findings'],
	batchIds: Set<string>
): Promise<void> {
	for (const finding of findings) {
		const [row] = await tx
			.insert(feedbackFindings)
			.values({
				digestId,
				category: finding.category,
				summary: finding.summary,
				supporterCount: finding.supporterCount
			})
			.returning({ id: feedbackFindings.id });
		const evidenceRows = finding.evidence.map((evidence) => {
			// Evidence ids come from the classified batch itself — a
			// hallucinated id is impossible by construction, and this
			// assertion is the loud backstop (I2).
			if (!batchIds.has(evidence.commentId)) {
				throw new Error(`feedback digest: evidence ${evidence.commentId} is not in the classified batch`);
			}
			const concealed = concealEvidence(evidence.text.slice(0, EXCERPT_MAX), {
				hasAbuse: evidence.hasAbuse
			});
			return {
				findingId: row.id,
				commentId: evidence.commentId,
				sanitizedExcerpt: concealed.text,
				hasAbuse: evidence.hasAbuse ? 1 : 0,
				// The text THIS digest classified, pinned on the evidence
				// row: a later rescan refreshes the shared snapshot, and
				// an older completed digest must still reveal the words
				// it actually analyzed (codex).
				sourceText: evidence.text
			};
		});
		if (evidenceRows.length) await tx.insert(findingEvidence).values(evidenceRows);
	}
}

/**
 * Writes the complete digest row plus its finding/evidence children, inside
 * the write transaction the caller wraps. Returns the new digest id.
 */
async function insertDigestFindings(tx: LedgerHandle, run: DigestRun): Promise<number> {
	// A completed run resolves all earlier attempt state — the stale
	// "waiting for credits"/"failed" rows must not linger beside it.
	await clearTransientDigests(tx, run.channelId);
	const [digest] = await tx
		.insert(feedbackDigests)
		.values({
			channelId: run.channelId,
			windowStart: run.windowStart,
			windowEnd: run.windowEnd,
			status: 'complete',
			commentsClassified: run.classified.length,
			commentsFailed: run.failed,
			clusteringDegraded: Number(run.clusteringDegraded),
			pooledCount: run.pooled,
			creditsUsed: run.metered ? run.creditsCharged : null
		})
		.returning({ id: feedbackDigests.id });
	await insertFindings(tx, digest.id, run.findings, run.batchIds);
	return digest.id;
}

/**
 * Stamps coverage for the whole batch, inside the write transaction. The
 * marker, not a timestamp edge, is the coverage record: only a committed
 * digest moves it, so an abort leaves the whole batch eligible for the
 * next run.
 */
async function markBatchCovered(tx: LedgerHandle, run: DigestRun): Promise<void> {
	const { channel, channelId, nowIso, historyPage } = run;
	if (historyPage) {
		await tx
			.insert(feedbackHistoryComments)
			// Refresh only the rows THIS page classified: the unfiltered page
			// can re-serve comments an earlier page of the same scan already
			// committed, and stamping them with the current text would let a
			// reveal show words no digest analyzed (cubic). Pre-nonce drains
			// (scanId null) keep the all-page refresh — they cannot tell the
			// scans apart.
			.values((channel.feedbackHistoryScanId === null ? historyPage.batch : run.batch).map((comment) => ({ ...comment, channelId, scanId: channel.feedbackHistoryScanId })))
			// The snapshot is what reveal/evidence prefers — a rescan that
			// classified edited text must refresh the row, or the page
			// shows words this scan never analyzed (codex+cubic). The
			// scan id re-stamps so the page-boundary dedupe knows this
			// scan committed it; channel_id stays with the first
			// writer — the refresh never steals another channel's row.
			.onConflictDoUpdate({
				target: feedbackHistoryComments.id,
				set: {
					text: sql`excluded.text`,
					publishedAt: sql`excluded.published_at`,
					scanId: sql`excluded.scan_id`
				}
			});
		await tx
			.update(comments)
			.set({ feedbackDigestedAt: nowIso })
			.where(and(eq(comments.channelId, channelId), inArray(comments.id, [...run.batchIds])));
		await advanceFeedbackHistory(tx, channel, historyPage);
		return;
	}
	await tx
		.update(comments)
		.set({ feedbackDigestedAt: nowIso })
		.where(and(eq(comments.channelId, channelId), inArray(comments.id, [...run.batchIds])));
	// Stamp the rotation only once the backlog is drained — a capped
	// batch leaves remainder comments unprocessed and the channel
	// must stay due so the next tick keeps draining (codex). The
	// count reads post-update state inside the same transaction.
	const remaining = await tx
		.select({ n: sql<number>`COUNT(*)` })
		.from(comments)
		.where(pendingStoredFeedback(channelId))
		.get();
	if ((remaining?.n ?? 0) === 0) {
		// The rotation stamp is the channel's own row — a 0-row
		// update means the channel vanished mid-run; fail loudly
		// and roll back.
		const stamped = await tx
			.update(channels)
			.set({ feedbackLastDigestAt: nowIso })
			.where(eq(channels.id, channelId))
			.returning({ id: channels.id });
		if (!stamped.length) throw new Error(`channel ${channelId} vanished mid-digest — aborting`);
	} else {
		// Backlog remains → no stamp, the channel stays due. Still
		// assert the channel is alive: a mid-run delete must abort.
		const alive = await tx
			.select({ id: channels.id })
			.from(channels)
			.where(eq(channels.id, channelId))
			.get();
		if (!alive) throw new Error(`channel ${channelId} vanished mid-digest — aborting`);
	}
}

/**
 * The write transaction: digest + findings + evidence + per-comment digest
 * markers + the rotation stamp commit together or not at all — never a
 * partial digest.
 */
async function writeDigestRun(run: DigestRun): Promise<{ digestId: number }> {
	return db.transaction(async (tx) => {
		const digestId = await insertDigestFindings(tx, run);
		await markBatchCovered(tx, run);
		return { digestId };
	});
}

/**
 * The pre-run gates: dry-run echo, inactive/disabled skips, and the cadence
 * check. Returns the early outcome, or null when the run may proceed.
 */
async function digestGateResult(
	channel: typeof channels.$inferSelect,
	channelId: string,
	force: boolean,
	forceDryRun: boolean
): Promise<DigestResult | null> {
	if (env.DRY_RUN !== 'true' && env.DRY_RUN !== 'false') {
		throw new Error('DRY_RUN must be true or false');
	}
	const dryRun = forceDryRun || env.DRY_RUN === 'true';
	if (dryRun) {
		console.info(`dry run: feedback digest for ${channelId} skipped — no rows written`);
		return { status: 'dry-run' };
	}
	if (!channel.active) return { status: 'skipped', reason: 'inactive' };
	if (channel.feedbackEnabled !== 1) return { status: 'skipped', reason: 'disabled' };
	if (!force && !(await digestDue(channel))) return { status: 'skipped', reason: 'cadence' };
	return null;
}

/**
 * Maps a thrown run failure to its visible outcome and records the
 * transient row, so the page shows the state instead of silence.
 */
async function digestFailureResult(
	cause: unknown,
	channel: typeof channels.$inferSelect,
	channelId: string,
	windowStart: string,
	windowEnd: string,
	historyPage: FeedbackHistoryPage | undefined
): Promise<DigestResult> {
	if (cause instanceof DeadlineExceededError) {
		// Budget gone — defer to the next tick; the window never advanced.
		console.info(`feedback digest for ${channelId} deferred: deadline exceeded`);
		await markDigestState(channelId, windowStart, windowEnd, 'deferred', 'deadline', channel);
		return { status: 'deferred', reason: 'deadline', ...(historyPage ? { historyRemaining: true } : {}) };
	}
	if (cause instanceof InsufficientCreditsError) {
		// The row makes the blockage channel-visible: without it the page
		// shows "No digest yet" while every tick repeats the deferral
		// (codex). A later complete/failed row clears it.
		console.warn(`feedback digest for ${channelId} deferred: ${cause.message}`);
		await markDigestState(channelId, windowStart, windowEnd, 'deferred', 'credits', channel);
		return { status: 'deferred', reason: 'credits', ...(historyPage ? { historyRemaining: true } : {}) };
	}
	console.error('feedback digest for %s failed:', channelId, cause);
	await markDigestState(channelId, windowStart, windowEnd, 'failed', 'error', channel);
	return { status: 'failed', reason: 'error', ...(historyPage ? { historyRemaining: true } : {}) };
}

/**
 * The digest pipeline body: charge the batch, classify, merge recurring
 * themes, then write the run transactionally. `setPhase` reports the phase
 * boundary each stage enters so the caller's stopped-log names the real
 * phase that failed or was interrupted.
 */
async function runDigestPipeline({
	channel,
	channelId,
	selection,
	metered,
	apiKey,
	deadline,
	nowIso,
	setPhase
}: {
	channel: typeof channels.$inferSelect;
	channelId: string;
	selection: SelectedBatch;
	metered: boolean;
	apiKey: string;
	deadline: number | undefined;
	nowIso: string;
	setPhase: (phase: string) => void;
}): Promise<DigestResult> {
	const { batch, windowStart, windowEnd, historyPage, historyScanScope } = selection;
	setPhase('billing');
	const creditsCharged =
		metered && channel.orgId ? await chargeFeedbackBatch(channel.orgId, batch, historyScanScope, deadline) : 0;

	// Per-comment failures are counted and skipped (I1); a deadline aborts
	// the whole run so the tick can defer cleanly.
	setPhase('classification');
	const { classified, failed } = await classifyBatch(batch, deadline, apiKey);
	// Every comment failing is a job failure, not an empty digest —
	// 'complete' would mark them digested and permanently skip coverage.
	// Throw so the run is marked failed and the next tick retries.
	if (failed > 0 && classified.length === 0) {
		throw new Error(`classification failed for all ${failed} comments`);
	}

	const threshold = channel.feedbackThreshold ?? 3;
	const categories = enabledCategories(channel);
	// The AI theme pass merges differently-worded claims for the same
	// recurring feedback BEFORE grouping — otherwise exact claim matching
	// undercounts what actually comes up most. The merge runs one call
	// per category: themes never merge across categories anyway, so a
	// mixed batch only let the model emit a malformed cross-category
	// theme. Unusable assignments retain their original claims and
	// complete with a visible reduced-grouping notice.
	// Its request is bounded by the write reserve so the model call can
	// never consume the headroom the persistence tx needs (codex/cubic).
	const clusterDeadline = deadline === undefined ? undefined : deadline - WRITE_RESERVE_MS;
	setPhase('clustering');
	const { classified: themed, clusteringDegraded } = themePassCanMatter(classified, categories, threshold)
		? await clusterClassifiedClaims(classified, categories, threshold, clusterDeadline, apiKey)
		: { classified, clusteringDegraded: false };
	const { findings, pooled } = groupFeedback(themed, { categories, threshold });

	// Reserve write headroom, not just the deadline edge: the persistence
	// tx is the slowest remaining phase and a kill mid-transaction would
	// force the (charged) classifications to be repeated next run.
	setPhase('write-reserve');
	if (deadline !== undefined && Date.now() > deadline - WRITE_RESERVE_MS) {
		throw new DeadlineExceededError();
	}
	setPhase('write');
	const result = await withBusyRetry(() =>
		writeDigestRun({
			channel,
			channelId,
			nowIso,
			windowStart,
			windowEnd,
			batch,
			batchIds: new Set(batch.map((c) => c.id)),
			classified,
			failed,
			clusteringDegraded,
			findings,
			pooled,
			metered,
			creditsCharged,
			historyPage
		})
	);
	return {
		status: 'complete',
		digestId: result.digestId,
		commentsClassified: classified.length,
		commentsFailed: failed,
		...(clusteringDegraded ? { clusteringDegraded: true } : {}),
		findings: findings.length,
		pooled,
		creditsUsed: creditsCharged,
		...(historyPage ? { historyRemaining: !historyPage.complete } : {})
	};
}

/**
 * Generates the feedback digest for one channel over the window since the
 * last complete digest. Bounded (≤ DIGEST_COMMENT_CAP comments, oldest
 * first so bursts drain forward), metered per classified comment for
 * metered orgs, and transactional: digest + findings + evidence + charges
 * + the rotation stamp commit together or not at all.
 *
 * @returns The run outcome — 'complete' | 'empty' | 'deferred' | 'skipped' | 'failed' | 'dry-run'.
 */
export async function generateFeedbackDigest(
	channelId: string,
	{ deadline, force = false, forceDryRun = false }: DigestOptions = {}
): Promise<DigestResult> {
	const startedAt = Date.now();
	let phase = 'load';
	let batchSize = 0;
	let outcome: DigestResult | undefined;
	try {
		const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();
		if (!channel) throw new Error(`channel not found: ${channelId}`);
		phase = 'gate';
		const gated = await digestGateResult(channel, channelId, force, forceDryRun);
		if (gated) {
			outcome = gated;
			return outcome;
		}

		const nowIso = new Date().toISOString();
		phase = 'selection';
		const selection = channel.feedbackHistoryBoundary
			? await selectHistoryBatch(channel, channelId, nowIso, deadline)
			: await selectStoredBatch(channelId, nowIso);
		if ('status' in selection) {
			outcome = selection;
			return outcome;
		}
		const { batch, windowStart, windowEnd, historyPage, historyScanScope } = selection;
		batchSize = batch.length;

		// The OpenAI key comes from the org's BYOK resolution — a lifetime org
		// without a usable key gets NO deployment-key fallback (openaiKey.ts);
		// the run fails loudly instead of burning operator money.
		phase = 'key-resolution';
		const apiKey = await resolveOpenAiKey(channel.orgId);
		if (!apiKey) {
			console.error(`feedback digest for ${channelId}: no OpenAI key resolved — marking failed`);
			await markDigestState(channelId, windowStart, windowEnd, 'failed', 'scoring', channel);
			outcome = { status: 'failed', reason: 'no-key', ...(historyPage ? { historyRemaining: true } : {}) };
			return outcome;
		}

		phase = 'metering';
		const metered = channel.orgId ? await orgIsMetered(channel.orgId) : false;

		phase = 'billing';
		try {
			outcome = await runDigestPipeline({
				channel,
				channelId,
				selection,
				metered,
				apiKey,
				deadline,
				nowIso,
				setPhase: (p) => { phase = p; }
			});
			return outcome;
		} catch (cause) {
			outcome = await digestFailureResult(cause, channel, channelId, windowStart, windowEnd, historyPage);
			return outcome;
		}
	} finally {
		if (!outcome || outcome.status === 'failed' || outcome.status === 'deferred') {
			const stoppedAt = Date.now();
			console.info('feedback digest stopped:', {
				channelId, phase, elapsedMs: stoppedAt - startedAt,
				remainingMs: deadline === undefined ? null : deadline - stoppedAt, batchSize
			});
		}
	}
}

export interface FeedbackPreview {
	commentsClassified: number;
	commentsFailed: number;
	clusteringDegraded?: boolean;
	pooled: number;
	hasMore: boolean;
	findings: {
		category: string;
		summary: string;
		supporterCount: number;
		evidence: { sanitizedExcerpt: string; hasAbuse: number }[];
	}[];
}

/**
 * The free feedback dry-run preview, split into plant + execute-and-persist
 * (MOD-229): startFeedbackPreview writes the 'dry-run-pending' row BEFORE
 * any provider call — the row is the resume record a crashed run leaves for
 * the cron drainer (I3) — then runFeedbackPreview executes the usual
 * pipeline and flips the same row to 'dry-run' with its findings in ONE
 * transaction. A preview consumes no coverage and no credits: it never
 * stamps comments.feedback_digested_at or feedback_history_comments, never
 * calls chargeFeedbackBatch, and persists creditsUsed=null (I8/I4).
 */
export async function startFeedbackPreview(
	channelId: string,
	{ boundary, claim }: { boundary: string; claim?: DryRunClaim }
): Promise<number> {
	return db.transaction(async (tx) => {
		const channel = await tx.select().from(channels).where(eq(channels.id, channelId)).get();
		if (!channel) throw new Error(`channel not found: ${channelId}`);
		// Same binding as the moderation preview: the row loaded here must be
		// the row the allowance claimed, or a delete/reconnect slipped in a
		// fresh connector under the same id (cubic+codeant).
		if (claim && !channelMatchesClaim(channel, claim)) {
			throw new Error(`channel ${channelId} changed under the dry-run claim — aborting the preview`);
		}
		if (!channel.active) throw new Error(ERR_PREVIEW_PAUSED);
		// windowEnd starts as the plant time (audit trail) and is replaced by
		// the batch's newest publishedAt when the run completes; the drainer's
		// stale age-out measures from attempted_at, stamped on first claim —
		// never from the plant, so queued rows can't expire unattempted.
		const [row] = await tx
			.insert(feedbackDigests)
			.values({
				channelId,
				windowStart: boundary,
				windowEnd: new Date().toISOString(),
				status: 'dry-run-pending'
			})
			.returning({ id: feedbackDigests.id });
		return row.id;
	});
}

/**
 * Executes the preview against a planted 'dry-run-pending' row and resolves
 * it transactionally: 'dry-run' with its findings on success,
 * 'dry-run-failed' with error='preview' on a run error — a distinct terminal
 * status so transient cleanup and window anchoring never treat a dead
 * preview as digest attempt state — while a deadline abort leaves the row
 * pending so the cron drainer retries it (I3). The pending row IS the
 * request: its windowStart stores the boundary the claimant asked for, so a
 * mismatched argument is a caller bug and fails loudly.
 */
export async function runFeedbackPreview(
	channelId: string,
	digestId: number,
	{ boundary, deadline, claim }: { boundary: string; deadline?: number; claim?: DryRunClaim }
): Promise<FeedbackPreview> {
	try {
		const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();
		if (!channel) throw new Error(`channel not found: ${channelId}`);
		// Re-verified between plant and run — a reconnect may have swapped the
		// connector while this preview waited in the queue.
		if (claim && !channelMatchesClaim(channel, claim)) {
			throw new Error(`channel ${channelId} changed under the dry-run claim — aborting the preview`);
		}
		if (!channel.active) throw new Error(ERR_PREVIEW_PAUSED);
		const pending = await db.select().from(feedbackDigests).where(eq(feedbackDigests.id, digestId)).get();
		if (!pending || pending.channelId !== channelId) {
			throw new Error(`preview digest ${digestId} not found for channel ${channelId}`);
		}
		if (pending.status !== 'dry-run-pending') {
			throw new Error(`preview digest ${digestId} is ${pending.status}, not pending — refusing to rerun`);
		}
		if (pending.windowStart !== boundary) {
			throw new Error(`preview digest ${digestId} boundary mismatch: planted ${pending.windowStart}, requested ${boundary}`);
		}
		const apiKey = await resolveOpenAiKey(channel.orgId);
		if (!apiKey) throw new Error(ERR_PREVIEW_NO_KEY);
		const page = await fetchFeedbackPage(channel, boundary, null, deadline);
		const { classified, failed } = page.batch.length
			? await classifyBatch(page.batch, deadline, apiKey)
			: { classified: [], failed: 0 };
		if (failed > 0 && classified.length === 0) throw new Error(`classification failed for all ${failed} preview comments`);
		const categories = enabledCategories(channel);
		const threshold = channel.feedbackThreshold ?? 3;
		// Same write reserve as the digest path: the clustering call gets the
		// reserved bound so it can never consume the headroom the persistence
		// tx needs (codex).
		const clusterDeadline = deadline === undefined ? undefined : deadline - WRITE_RESERVE_MS;
		const { classified: themed, clusteringDegraded } = themePassCanMatter(classified, categories, threshold)
			? await clusterClassifiedClaims(classified, categories, threshold, clusterDeadline, apiKey)
			: { classified, clusteringDegraded: false };
		const { findings, pooled } = groupFeedback(themed, { categories, threshold });
		const batchIds = new Set(page.batch.map((comment) => comment.id));
		// Abort before the write when the reserve is already spent — entering
		// the tx would race the caller's hard abort and leave the commit
		// outcome unknown (codex). DeadlineExceededError leaves the row
		// pending, so the retry runs with real headroom.
		if (deadline !== undefined && Date.now() > deadline - WRITE_RESERVE_MS) {
			throw new DeadlineExceededError();
		}
		// ONE transaction resolves the row and writes its children — never a
		// partial preview. The guarded UPDATE is the idempotency backstop: a
		// second runner (expired lease → cron pickup) finds the row no longer
		// pending and aborts instead of double-writing findings (I4).
		await withBusyRetry(() =>
			db.transaction(async (tx) => {
				const flipped = await tx
					.update(feedbackDigests)
					.set({
						status: 'dry-run',
						// An empty batch has no newest publishedAt — keep the plant stamp.
						windowEnd: page.batch.at(-1)?.publishedAt ?? pending.windowEnd,
						commentsClassified: classified.length,
						commentsFailed: failed,
						clusteringDegraded: Number(clusteringDegraded),
						pooledCount: pooled
					})
					.where(
						and(
							eq(feedbackDigests.id, digestId),
							eq(feedbackDigests.channelId, channelId),
							eq(feedbackDigests.status, 'dry-run-pending')
						)
					)
					.returning({ id: feedbackDigests.id });
				if (!flipped.length) throw new Error(`preview digest ${digestId} left pending state mid-run — aborting the write`);
				await insertFindings(tx, digestId, findings, batchIds);
			})
		);
		return {
			commentsClassified: classified.length,
			commentsFailed: failed,
			...(clusteringDegraded ? { clusteringDegraded: true } : {}),
			pooled,
			hasMore: !page.complete,
			findings: findings.map((finding) => ({
				category: finding.category,
				summary: finding.summary,
				supporterCount: finding.supporterCount,
				evidence: finding.evidence.map((evidence) => ({
					sanitizedExcerpt: concealEvidence(evidence.text.slice(0, EXCERPT_MAX), { hasAbuse: evidence.hasAbuse }).text,
					hasAbuse: evidence.hasAbuse ? 1 : 0
				}))
			}))
		};
	} catch (cause) {
		if (cause instanceof DeadlineExceededError) throw cause;
		console.error('feedback preview failed for channel %s (digest %s):', channelId, digestId, cause);
		try {
			// Scoped to THIS channel's pending row: a wrong-id call must not
			// clobber another channel's in-flight preview. 'dry-run-failed' is
			// NOT a transient status — the row survives later runs' cleanup and
			// never anchors their windows (gitar PR 170).
			await db
				.update(feedbackDigests)
				.set({ status: 'dry-run-failed', error: 'preview' })
				.where(
					and(
						eq(feedbackDigests.id, digestId),
						eq(feedbackDigests.channelId, channelId),
						eq(feedbackDigests.status, 'dry-run-pending')
					)
				);
		} catch (markCause) {
			console.error('could not record preview failure for digest %s:', digestId, markCause);
		}
		throw cause;
	}
}


