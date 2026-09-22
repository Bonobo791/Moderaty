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

// Digest generation job (MOD-90): bounded cron rotation, per-channel
// cadence, credit metering, and all-or-nothing persistence. Metered orgs
// are charged up front in one transaction — before any provider call —
// anchored per comment so a crashed run retries without double-charging;
// a shortfall defers with the balance untouched. The write transaction
// then commits digest + findings + evidence + the per-comment digest
// markers + the rotation stamp together, or not at all — never a partial
// digest. Per-comment classifier failures are counted and skipped (I1);
// a job-level failure records a 'failed' row so the page can say so
// instead of silently showing stale data.

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, withBusyRetry } from '$lib/server/db';
import { channels, comments, creditTransactions, feedbackDigests, feedbackFindings, findingEvidence } from '$lib/server/db/schema';
import { classifyFeedback, type FeedbackCategory } from '$lib/server/feedback';
import { concealEvidence } from '$lib/server/feedbackSanitize';
import { groupFeedback } from '$lib/server/feedbackGroup';
import { DeadlineExceededError } from '$lib/server/http';
import { consumeFeedbackCredit, orgIsMetered, type LedgerHandle } from '$lib/server/billing/ledger';
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

export type DigestStatus = 'complete' | 'empty' | 'deferred' | 'skipped' | 'failed' | 'dry-run';

export interface DigestResult {
	status: DigestStatus;
	/** Why a non-complete run stopped — 'disabled' | 'inactive' | 'cadence' | 'credits' | 'no-key' | 'deadline' | failure category. */
	reason?: string;
	digestId?: number;
	commentsClassified?: number;
	commentsFailed?: number;
	findings?: number;
	pooled?: number;
	creditsUsed?: number;
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
 * Is this channel's digest due right now?
 * - manual: never auto — the dashboard's "generate now" passes force.
 * - per_100: ≥100 stored comments still carry a NULL digest marker.
 * - weekly (default + unknown values, loudly): last evaluation ≥ 7 days ago.
 */
export async function digestDue(channel: typeof channels.$inferSelect, now = Date.now()): Promise<boolean> {
	const cadence = channel.feedbackCadence ?? 'weekly';
	if (cadence === 'manual') return false;
	if (cadence === 'per_100') {
		// Unprocessed is the marker, not a timestamp — a backfilled comment
		// with an old publishedAt counts the same as a fresh one.
		const row = await db
			.select({ n: sql<number>`COUNT(*)` })
			.from(comments)
			.where(and(eq(comments.channelId, channel.id), isNull(comments.feedbackDigestedAt)))
			.get();
		return (row?.n ?? 0) >= PER_100_COUNT;
	}
	if (cadence !== 'weekly') {
		console.error(`channel ${channel.id} has unknown feedback cadence "${cadence}" — treating as weekly`);
	}
	if (!channel.feedbackLastDigestAt) return true;
	return Date.parse(channel.feedbackLastDigestAt) + WEEK_MS <= now;
}

/**
 * Replaces any existing digest for the same (channel, window) — the
 * idempotency anchor (I4): a re-run converges to one row set instead of
 * erroring on the unique index. Children die first, explicitly.
 */
async function replaceWindowDigest(
	tx: LedgerHandle,
	channelId: string,
	windowStart: string,
	windowEnd: string
): Promise<void> {
	const existing = await tx
		.select({ id: feedbackDigests.id })
		.from(feedbackDigests)
		.where(
			and(
				eq(feedbackDigests.channelId, channelId),
				eq(feedbackDigests.windowStart, windowStart),
				eq(feedbackDigests.windowEnd, windowEnd)
			)
		)
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

/** Records a loud failure row (idempotent on the window anchor) and reports the sanitized category. */
async function markDigestFailed(channelId: string, windowStart: string, windowEnd: string, reason: string): Promise<void> {
	try {
		await db.transaction(async (tx) => {
			// A channel deleted mid-run gets no posthumous rows — the
			// existence check mirrors the stamp guard in the main write.
			const alive = await tx
				.select({ id: channels.id })
				.from(channels)
				.where(eq(channels.id, channelId))
				.get();
			if (!alive) throw new Error(`channel ${channelId} vanished — skipping failure record`);
			await replaceWindowDigest(tx, channelId, windowStart, windowEnd);
			await tx.insert(feedbackDigests).values({
				channelId,
				windowStart,
				windowEnd,
				status: 'failed',
				error: reason
			});
		});
	} catch (cause) {
		// The failure row itself failed to write — log loudly; the next tick
		// retries the same window (it never advanced).
		console.error(`could not record digest failure for channel ${channelId}:`, cause);
	}
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
	const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();
	if (!channel) throw new Error(`channel not found: ${channelId}`);
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
		.where(and(eq(comments.channelId, channelId), isNull(comments.feedbackDigestedAt)))
		.orderBy(asc(instant(comments.publishedAt)), asc(comments.id))
		.limit(DIGEST_COMMENT_CAP)
		.all();
	const nowIso = new Date().toISOString();
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
	const windowStart = Date.parse(batch[0].publishedAt) < Date.parse(since) ? batch[0].publishedAt : since;
	const windowEnd = batch[batch.length - 1].publishedAt;

	// The OpenAI key comes from the org's BYOK resolution — a lifetime org
	// without a usable key gets NO deployment-key fallback (openaiKey.ts);
	// the run fails loudly instead of burning operator money.
	const apiKey = await resolveOpenAiKey(channel.orgId);
	if (!apiKey) {
		console.error(`feedback digest for ${channelId}: no OpenAI key resolved — marking failed`);
		await markDigestFailed(channelId, windowStart, windowEnd, 'scoring');
		return { status: 'failed', reason: 'no-key' };
	}

	const metered = channel.orgId ? await orgIsMetered(channel.orgId) : false;

	try {
		// Charge the whole batch BEFORE any provider call, in ONE
		// transaction: the (org, 'feedback', commentId) anchor makes each
		// charge idempotent — a run that crashed between charge and write
		// retries classification without paying again. All-or-nothing, so a
		// shortfall defers with the balance untouched; and because the money
		// is committed before the LLM call, a second same-org channel can no
		// longer race a read-only precheck into wasted provider spend
		// (codex).
		let creditsCharged = 0;
		if (metered && channel.orgId) {
			const orgId = channel.orgId;
			await db.transaction(async (tx) => {
				for (const comment of batch) {
					const charged = await consumeFeedbackCredit(tx, orgId, comment.id);
					if (charged) {
						creditsCharged++;
						continue;
					}
					// False also covers "already charged" — distinguish by
					// looking for the anchor row before calling it a shortfall.
					const prior = await tx
						.select({ id: creditTransactions.id })
						.from(creditTransactions)
						.where(
							and(
								eq(creditTransactions.orgId, orgId),
								eq(creditTransactions.refType, 'feedback'),
								eq(creditTransactions.refId, comment.id)
							)
						)
						.get();
					if (!prior) throw new Error('insufficient credits for feedback digest');
				}
			});
		}

		// Per-comment failures are counted and skipped (I1); a deadline aborts
		// the whole run so the tick can defer cleanly.
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
				console.error(`feedback classification failed for comment ${batch[i].id}:`, outcome.reason);
				continue;
			}
			classified.push({ commentId: batch[i].id, text: batch[i].text, publishedAt: batch[i].publishedAt, ...outcome.value });
		}
		// Every comment failing is a job failure, not an empty digest —
		// 'complete' would mark them digested and permanently skip coverage.
		// Throw so the run is marked failed and the next tick retries.
		if (failed > 0 && classified.length === 0) {
			throw new Error(`classification failed for all ${failed} comments`);
		}

		const threshold = channel.feedbackThreshold ?? 3;
		const { findings, pooled } = groupFeedback(classified, {
			categories: enabledCategories(channel),
			threshold
		});

		const batchIds = new Set(batch.map((c) => c.id));
		// Reserve write headroom, not just the deadline edge: the persistence
		// tx is the slowest remaining phase and a kill mid-transaction would
		// force the (charged) classifications to be repeated next run.
		if (deadline !== undefined && Date.now() > deadline - WRITE_RESERVE_MS) {
			throw new DeadlineExceededError();
		}
		const result = await withBusyRetry(() =>
			db.transaction(async (tx) => {
				await replaceWindowDigest(tx, channelId, windowStart, windowEnd);
				const [digest] = await tx
					.insert(feedbackDigests)
					.values({
						channelId,
						windowStart,
						windowEnd,
						status: 'complete',
						commentsClassified: classified.length,
						commentsFailed: failed,
						pooledCount: pooled,
						creditsUsed: metered ? creditsCharged : null
					})
					.returning({ id: feedbackDigests.id });
				for (const finding of findings) {
					const [row] = await tx
						.insert(feedbackFindings)
						.values({
							digestId: digest.id,
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
							throw new Error(`feedback digest: evidence ${evidence.commentId} is not a stored comment`);
						}
						const concealed = concealEvidence(evidence.text.slice(0, EXCERPT_MAX), {
							hasAbuse: evidence.hasAbuse
						});
						return {
							findingId: row.id,
							commentId: evidence.commentId,
							sanitizedExcerpt: concealed.text,
							hasAbuse: evidence.hasAbuse ? 1 : 0
						};
					});
					if (evidenceRows.length) await tx.insert(findingEvidence).values(evidenceRows);
				}
				// Mark every comment the run covered — classified, counted-failed,
				// or 'none' — as digested. The marker, not a timestamp edge, is
				// the coverage record: only a committed digest moves it, so an
				// abort leaves the whole batch eligible for the next run.
				await tx
					.update(comments)
					.set({ feedbackDigestedAt: nowIso })
					.where(inArray(comments.id, [...batchIds]));
				// Stamp the rotation only once the backlog is drained — a capped
				// batch leaves remainder comments unprocessed and the channel
				// must stay due so the next tick keeps draining (codex). The
				// count reads post-update state inside the same transaction.
				const remaining = await tx
					.select({ n: sql<number>`COUNT(*)` })
					.from(comments)
					.where(and(eq(comments.channelId, channelId), isNull(comments.feedbackDigestedAt)))
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
				return { digestId: digest.id };
			})
		);
		return {
			status: 'complete',
			digestId: result.digestId,
			commentsClassified: classified.length,
			commentsFailed: failed,
			findings: findings.length,
			pooled,
			creditsUsed: creditsCharged
		};
	} catch (cause) {
		if (cause instanceof DeadlineExceededError) {
			// Budget gone — defer to the next tick; the window never advanced.
			console.info(`feedback digest for ${channelId} deferred: deadline exceeded`);
			return { status: 'deferred', reason: 'deadline' };
		}
		if (cause instanceof Error && /insufficient credits/.test(cause.message)) {
			console.warn(`feedback digest for ${channelId} deferred: ${cause.message}`);
			return { status: 'deferred', reason: 'credits' };
		}
		console.error(`feedback digest for ${channelId} failed:`, cause);
		await markDigestFailed(channelId, windowStart, windowEnd, 'error');
		return { status: 'failed', reason: 'error' };
	}
}
