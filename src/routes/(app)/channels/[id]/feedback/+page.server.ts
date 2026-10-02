import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { error, fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { randomUUID } from 'node:crypto';

import { db } from '$lib/server/db';
import { channels, comments, feedbackDigests, feedbackFindings, feedbackHistoryComments, findingEvidence } from '$lib/server/db/schema';
import { enabledCategories, generateFeedbackDigest, runFeedbackPreview, startFeedbackPreview, TRANSIENT_DIGEST_STATUSES, type DigestResult } from '$lib/server/feedbackDigest';
import { claimDryRun } from '$lib/server/dryRun';
import { historyAccessError } from '$lib/server/historyAccess';
import { historyWindowBoundary, parseHistoryWindow } from '$lib/historyWindow';
import { ownedChannel, requireOrgRole } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';

/** The four digest categories, in display order — the only values accepted by the settings form. */
const VALID_CATEGORIES = ['question', 'criticism', 'correction', 'request'] as const;

/** Manual runs share the cron bounding idea: a hard ceiling, then a clean defer. */
const MANUAL_RUN_BUDGET_MS = 15_000;

/** Digest rows a history page lists — older ones paginate off behind a cursor. */
const HISTORY_PAGE_SIZE = 25;

/** Rows with finished, viewable findings — paid digests and completed previews. */
const SELECTABLE_DIGEST_STATUSES = ['complete', 'dry-run'] as const;

const DIGEST_FIELDS = {
	id: feedbackDigests.id,
	windowStart: feedbackDigests.windowStart,
	windowEnd: feedbackDigests.windowEnd,
	status: feedbackDigests.status,
	commentsClassified: feedbackDigests.commentsClassified,
	commentsFailed: feedbackDigests.commentsFailed,
	clusteringDegraded: feedbackDigests.clusteringDegraded,
	pooledCount: feedbackDigests.pooledCount,
	creditsUsed: feedbackDigests.creditsUsed,
	error: feedbackDigests.error,
	createdAt: feedbackDigests.createdAt
} as const;

/**
 * One page of a channel's digest history, newest first: complete digests
 * and finished previews — each a batch whose findings stay selectable —
 * are permanent rows, plus anything newer than the newest complete (the
 * current attempt state: transient rows and pending/failed previews;
 * older leftovers are resolved noise). `before` is the cursor — the
 * oldest id of the previous page — so a high-volume channel's backlog
 * never loads, serializes, and renders all at once (codex #155). Ids are
 * monotonic; createdAt can tie within a millisecond.
 */
async function digestHistoryPage(channelId: string, latestCompleteId: number, before?: number) {
	const rows = await db
		.select(DIGEST_FIELDS)
		.from(feedbackDigests)
		.where(
			and(
				eq(feedbackDigests.channelId, channelId),
				or(
					inArray(feedbackDigests.status, SELECTABLE_DIGEST_STATUSES),
					gt(feedbackDigests.id, latestCompleteId)
				),
				before === undefined ? undefined : lt(feedbackDigests.id, before)
			)
		)
		.orderBy(desc(feedbackDigests.id))
		.limit(HISTORY_PAGE_SIZE + 1)
		.all();
	const digests = rows.slice(0, HISTORY_PAGE_SIZE);
	return { digests, next: rows.length > HISTORY_PAGE_SIZE ? (digests.at(-1)?.id ?? null) : null };
}

export async function load({ params, locals, url }) {
	// Database outage: the layout renders the overlay; this load must not 401
	// on the null-user outage shape.
	if (locals.dbDown) return { ch: { id: params.id, title: '' }, maintenance: true };
	const ch = await ownedChannel(params.id, locals);
	// The newest COMPLETE digest is its own query: a streak of failed rows
	// must not bury it and make the page claim none exists (codex).
	const latest =
		(await db
			.select(DIGEST_FIELDS)
			.from(feedbackDigests)
			.where(and(eq(feedbackDigests.channelId, params.id), eq(feedbackDigests.status, 'complete')))
			// id is monotonic — createdAt can tie within a millisecond (cubic).
			.orderBy(desc(feedbackDigests.id))
			.limit(1)
			.get()) ?? null;
	// ?history=<id> pages the history list behind a cursor; ?digest=<id>
	// still selects any complete digest directly regardless of page (codex).
	// Only a positive safe integer is a cursor: Number('') and '0' parse to 0,
	// which would turn the id < before filter into an empty, un-navigable
	// page — malformed input falls back to the first page (cubic/coderabbit).
	const historyCursor = url.searchParams.get('history');
	const parsedCursor = historyCursor === null ? NaN : Number(historyCursor);
	const historyBefore =
		Number.isSafeInteger(parsedCursor) && parsedCursor > 0 ? parsedCursor : undefined;
	const historyPage = await digestHistoryPage(params.id, latest?.id ?? -1, historyBefore);
	const digests = historyPage.digests;
	const latestComplete = latest;
	// The status banner's transient row (failed/deferred current attempt) is
	// its own query: on an older ?history= page the row is not in `digests`
	// at all, and paging must not hide the live warning (coderabbit/cubic).
	const currentAttempt =
		(await db
			.select(DIGEST_FIELDS)
			.from(feedbackDigests)
			.where(
				and(
					eq(feedbackDigests.channelId, params.id),
					// The banner names a failed/deferred RUN only — preview rows
					// are lifecycle state and would hide a real attempt behind a
					// status the page cannot render (gitar+codex PR 170).
					inArray(feedbackDigests.status, TRANSIENT_DIGEST_STATUSES),
					gt(feedbackDigests.id, latest?.id ?? -1)
				)
			)
			.orderBy(desc(feedbackDigests.id))
			.limit(1)
			.get()) ?? null;
	// Every finished digest is selectable (?digest=N): a multi-page history
	// drain writes one digest per bounded batch, and the paid findings on
	// earlier pages stay reachable instead of being replaced by the newest
	// page's result (codex); finished previews select the same way. A
	// forged/stale/non-finished id falls back to latest — the param only
	// ever selects, never leaks.
	const digestParam = Number(url.searchParams.get('digest'));
	const selected =
		(Number.isInteger(digestParam) &&
			(await db
				.select(DIGEST_FIELDS)
				.from(feedbackDigests)
				.where(
					and(
						eq(feedbackDigests.channelId, params.id),
						eq(feedbackDigests.id, digestParam),
						inArray(feedbackDigests.status, SELECTABLE_DIGEST_STATUSES)
					)
				)
				.get())) ||
		latestComplete ||
		// No paid digest yet: the newest finished preview is still the
		// channel's first result — its findings render without needing a
		// ?digest= deep link (MOD-232). Only queried when nothing above hit.
		((await db
			.select(DIGEST_FIELDS)
			.from(feedbackDigests)
			.where(and(eq(feedbackDigests.channelId, params.id), eq(feedbackDigests.status, 'dry-run')))
			.orderBy(desc(feedbackDigests.id))
			.limit(1)
			.get()) ?? null);
	let findings: {
		id: number;
		category: string;
		summary: string;
		supporterCount: number;
		evidence: { id: number; sanitizedExcerpt: string; hasAbuse: number }[];
	}[] = [];
	if (selected) {
		const rows = await db
			.select()
			.from(feedbackFindings)
			.where(eq(feedbackFindings.digestId, selected.id))
			.orderBy(desc(feedbackFindings.supporterCount))
			.all();
		const ids = rows.map((r) => r.id);
		const evidence = ids.length
			? await db
					.select({
						id: findingEvidence.id,
						findingId: findingEvidence.findingId,
						sanitizedExcerpt: findingEvidence.sanitizedExcerpt,
						hasAbuse: findingEvidence.hasAbuse
					})
					.from(findingEvidence)
					.where(inArray(findingEvidence.findingId, ids))
					.orderBy(asc(findingEvidence.id))
					.all()
			: [];
		findings = rows.map((f) => ({
			id: f.id,
			category: f.category,
			summary: f.summary,
			supporterCount: f.supporterCount,
			evidence: evidence
				.filter((e) => e.findingId === f.id)
				.map((e) => ({ id: e.id, sanitizedExcerpt: e.sanitizedExcerpt, hasAbuse: e.hasAbuse }))
		}));
	}
	// Project only what the page renders — never serialize refreshTokenEnc (or
	// any future secret column) to the browser.
	return {
		ch: { id: ch.id, title: ch.title, active: ch.active === 1 },
		history: { active: Boolean(ch.feedbackHistoryBoundary), boundary: ch.feedbackHistoryBoundary },
		dryRunUsed: Boolean(ch.feedbackDryRunUsedAt),
		dryRunDeployment: env.DRY_RUN === 'true',
		digests,
		currentAttempt,
		historyCursor: historyBefore ?? null,
		historyNext: historyPage.next,
		latest: latestComplete,
		selected,
		findings,
		settings: {
			enabled: ch.feedbackEnabled === 1,
			cadence: ch.feedbackCadence ?? 'weekly',
			categories: enabledCategories(ch),
			threshold: ch.feedbackThreshold ?? 3
		}
	};
}

/** The raw comment behind one evidence row, scoped to the channel it belongs to. */
function evidenceSource(channelId: string, evidenceId: number) {
	// The evidence row's pinned text wins: it is exactly what this digest's
	// classifier saw — a later rescan can refresh the shared history snapshot
	// with edited content, and this digest must still reveal its own words
	// (codex). The snapshot comes next for rows written before the column
	// existed, then the live comments row.
	const sourceText = sql<string>`coalesce(${findingEvidence.sourceText}, ${feedbackHistoryComments.text}, ${comments.text})`;
	return db
		.select({ text: sourceText, hasAbuse: findingEvidence.hasAbuse })
		.from(findingEvidence)
		.innerJoin(feedbackFindings, eq(feedbackFindings.id, findingEvidence.findingId))
		.innerJoin(feedbackDigests, eq(feedbackDigests.id, feedbackFindings.digestId))
		.leftJoin(comments, and(eq(comments.id, findingEvidence.commentId), eq(comments.channelId, channelId)))
		.leftJoin(feedbackHistoryComments, and(eq(feedbackHistoryComments.id, findingEvidence.commentId), eq(feedbackHistoryComments.channelId, channelId)))
		.where(
			and(
				eq(findingEvidence.id, evidenceId),
				eq(feedbackDigests.channelId, channelId),
				// The guard must match the projection: preview comments live in
				// neither store, and a deleted comment's digest keeps only its
				// pinned text — both reveal through sourceText alone (codeant).
				sql`${sourceText} IS NOT NULL`
			)
		)
		.get();
}

export const actions = {
	analyzeHistory: async ({ params, request, locals }) => {
		const user = requireUser(locals);
		requireOrgRole(user, 'owner');
		const ch = await ownedChannel(params.id, locals);
		const form = await request.formData();
		const rawWindow = form.get('months');
		const window = parseHistoryWindow(rawWindow instanceof File ? null : rawWindow ?? '3');
		if (window === null) return fail(400, { scope: 'history', error: 'Choose a history window of 1, 3, 6, 12, or 24 months.' });
		if (env.DRY_RUN !== 'true' && env.DRY_RUN !== 'false') throw error(500, 'DRY_RUN must be true or false');
		if (env.DRY_RUN === 'true') return fail(409, { scope: 'history', error: 'History scans are unavailable while this deployment is in dry-run mode.' });
		if (!ch.active || ch.feedbackEnabled !== 1) {
			return fail(409, { scope: 'history', error: 'Resume the channel and enable feedback before starting a history scan.' });
		}
		// Same gate as moderation history: every classified comment spends a
		// credit (or the org's own key), so a checkpoint must never plant for an
		// org with no access — cron would drain it on someone else's budget.
		try {
			const historyAccess = await historyAccessError(user.orgId);
			if (historyAccess) {
				console.warn('feedback history analysis blocked:', { channelId: params.id, orgId: user.orgId, reason: historyAccess });
				return fail(402, {
					scope: 'history',
					historyAccess,
					error: historyAccess === 'key'
						? 'Your lifetime deal requires your own OpenAI API key. An organization owner must add it on the Team page before starting a history scan.'
						: 'To run a history scan, purchase credits, subscribe, or buy the lifetime deal and add your own OpenAI API key. If your credits or subscription allowance are exhausted, purchase more credits to continue.'
				});
			}
		} catch (cause) {
			console.error('feedback history access check failed:', params.id, cause);
			return fail(503, { scope: 'history', error: 'Could not verify access to history scans. Please try again.' });
		}
		const now = new Date().toISOString();
		const claimable = or(isNull(channels.leaseExpiresAt), lt(channels.leaseExpiresAt, now));
		// A fresh scan id per request: the charge anchors it scopes make this
		// analysis debit each comment once — re-running the same window mints a
		// new id and charges again; a retry of THIS run hits the anchors and
		// classifies without a second debit.
		const updated = await db
			.update(channels)
			.set({ feedbackHistoryBoundary: historyWindowBoundary(window), feedbackHistoryPageToken: null, feedbackHistoryScanId: randomUUID() })
			.where(and(eq(channels.id, params.id), eq(channels.orgId, user.orgId), eq(channels.active, 1), eq(channels.feedbackEnabled, 1), isNull(channels.feedbackHistoryBoundary), claimable))
			.returning({ id: channels.id });
		if (!updated.length) return fail(409, { scope: 'history', error: 'A history scan is already running or this channel is busy.' });
		return {
			ok: true,
			scope: 'history',
			message: 'History scan started — up to 100 comments per background batch, and nothing is moderated. Each batch adds a digest below.'
		};
	},
	dryRun: async ({ params, request, locals }) => {
		const user = requireUser(locals);
		requireOrgRole(user, 'owner');
		const ch = await ownedChannel(params.id, locals);
		const form = await request.formData();
		const rawWindow = form.get('months');
		const window = parseHistoryWindow(rawWindow instanceof File ? null : rawWindow ?? '3', true);
		if (window === null) return fail(400, { scope: 'feedbackDryRun', error: 'Choose 1, 3, 6, 12, 24 months, or all time.' });
		if (env.DRY_RUN !== 'true' && env.DRY_RUN !== 'false') throw error(500, 'DRY_RUN must be true or false');
		if (!ch.active) return fail(409, { scope: 'feedbackDryRun', error: 'Resume the channel before running a dry run.' });
		let claim: Awaited<ReturnType<typeof claimDryRun>>;
		try {
			claim = await claimDryRun(params.id, user.orgId, 'feedback');
		} catch (cause) {
			console.error('feedback dry-run claim failed for channel:', params.id, cause);
			return fail(500, { scope: 'feedbackDryRun', error: 'The feedback dry run could not be started. Check the server log and try again.' });
		}
		if ('status' in claim) return fail(claim.status, { scope: 'feedbackDryRun', error: claim.error });
		const boundary = historyWindowBoundary(window);
		let digestId: number;
		try {
			// Same claim binding as the moderation preview: the row executing
			// must be the row that claimed the allowance (cubic+codeant).
			digestId = await startFeedbackPreview(params.id, { boundary, claim: claim.identity });
		} catch (cause) {
			console.error('feedback dry run failed for channel:', params.id, cause);
			return fail(500, { scope: 'feedbackDryRun', attempted: true, error: 'The feedback dry run could not be started. This attempt used your one free preview; no credits were charged. Check the server log.' });
		}
		// Lease ownership moves to the runner: the kick executes under the
		// claim's 60s lease (channelMatchesClaim still matches), and on a
		// deployment that freezes after the response the row simply stays
		// 'dry-run-pending' for the cron drainer (MOD-231). Unawaited by
		// design — the response must not wait on YouTube/OpenAI.
		void runFeedbackPreview(params.id, digestId, { boundary, deadline: Date.now() + MANUAL_RUN_BUDGET_MS, claim: claim.identity })
			.catch((cause) => console.error('feedback preview runner failed for channel:', params.id, cause))
			.finally(async () => {
				try {
					// Release only OUR lease: if it expired mid-run and the drainer
					// claimed the channel, that lease is untouched.
					await db
						.update(channels)
						.set({ leaseExpiresAt: null })
						.where(and(eq(channels.id, params.id), eq(channels.orgId, user.orgId), eq(channels.leaseExpiresAt, claim.lease)));
				} catch (cause) {
					console.error('feedback dry-run lease release failed for channel:', params.id, cause);
				}
			});
		return {
			ok: true,
			scope: 'feedbackDryRun',
			dryRunUsed: true,
			message: 'Free feedback preview started — it will appear under Recent digests at the bottom of this page. Limited to 1 per channel; no credits used.'
		};
	},
	reveal: async ({ params, request, locals }) => {
		const user = requireUser(locals);
		await ownedChannel(params.id, locals);
		const form = await request.formData();
		const evidenceId = Number(form.get('evidenceId'));
		if (!Number.isSafeInteger(evidenceId) || evidenceId <= 0) {
			return fail(400, { scope: 'reveal', error: 'Invalid evidence id.' });
		}
		const source = await evidenceSource(params.id, evidenceId);
		if (!source) {
			console.error('feedback evidence source unavailable:', { channelId: params.id, evidenceId, userId: user.id });
			return fail(404, { scope: 'reveal', evidenceId, error: 'The original comment is no longer available.' });
		}
		if (source.hasAbuse === 1 && form.get('confirmedAbuse') !== 'yes') {
			return { scope: 'reveal', evidenceId, confirmationRequired: true };
		}
		return { scope: 'reveal', evidenceId, text: source.text };
	},
	/** "Generate now" — a forced run over every comment the digest has not processed yet. */
	generate: async ({ params, locals }) => {
		// A run spends org credits on metered plans — owner-only like every
		// money-moving action; membership alone is not enough (codeant).
		const user = requireUser(locals);
		requireOrgRole(user, 'owner');
		const ch = await ownedChannel(params.id, locals);
		if (ch.feedbackEnabled !== 1) {
			return fail(400, { scope: 'digest', error: 'Enable the feedback digest below before generating.' });
		}
		// A manual run can overlap a cron digest — and its failure path can
		// clobber the concurrent run's success. Claim the channel lease first,
		// same protocol as the dry-run preview and cron: the UPDATE predicate
		// makes claimants single-winner, and the lease self-expires if this
		// request dies mid-run (codex).
		const myLease = new Date(Date.now() + 60_000).toISOString();
		const claimable = or(isNull(channels.leaseExpiresAt), lt(channels.leaseExpiresAt, new Date().toISOString()));
		const claimed = await db
			.update(channels)
			.set({ leaseExpiresAt: myLease })
			.where(and(eq(channels.id, params.id), eq(channels.orgId, user.orgId), claimable))
			.returning({ id: channels.id });
		if (!claimed.length) {
			return fail(409, { scope: 'digest', error: 'This channel is mid-scan — retry in a minute.' });
		}
		// A 'manual' cadence never gets a cron retry — don't promise one.
		const retryHint =
			ch.feedbackHistoryBoundary || ch.feedbackCadence !== 'manual'
				? 'it will retry automatically.'
				: 'retry with Generate now.';
		try {
			const result: DigestResult = await generateFeedbackDigest(params.id, {
				force: true,
				deadline: Date.now() + MANUAL_RUN_BUDGET_MS
			});
			switch (result.status) {
				case 'complete':
					return {
						ok: true,
						scope: 'digest',
						message: `Digest generated — ${result.findings} finding(s) from ${result.commentsClassified} comment(s).${result.historyRemaining ? ' The history scan continues in the background.' : ''}`
					};
				case 'empty':
					return {
						ok: true,
						scope: 'digest',
						message: result.historyRemaining
							? 'This history batch was scanned. The next batch runs automatically.'
							: 'No new comments since the last digest window.'
					};
				case 'dry-run':
					return fail(409, { scope: 'digest', error: 'This deployment runs in dry-run mode — digests cannot be generated.' });
				case 'deferred':
					return fail(409, {
						scope: 'digest',
						error: `Generation deferred (${result.reason ?? 'busy'}) — ${retryHint}`
					});
				case 'skipped':
					return fail(409, { scope: 'digest', error: 'The channel is paused — resume it before generating.' });
				default:
					return fail(502, {
						scope: 'digest',
						error: `Digest generation failed (${result.reason ?? 'error'}) — ${retryHint}`
					});
			}
		} catch (e) {
			// Loud server-side, generic client-side — raw provider detail never
			// reaches the browser.
			console.error('manual feedback digest failed for channel:', params.id, e);
			return fail(502, { scope: 'digest', error: 'Digest generation failed — check the server log and try again.' });
		} finally {
			// Release only OUR lease: if the run overran it and cron claimed the
			// channel in between, that lease is untouched.
			await db
				.update(channels)
				.set({ leaseExpiresAt: null })
				.where(and(eq(channels.id, params.id), eq(channels.leaseExpiresAt, myLease)));
		}
	},
	/** Per-channel feedback controls (MOD-91): opt-in, cadence, categories, threshold, e-mail flag. */
	settings: async ({ params, request, locals }) => {
		const user = requireUser(locals);
		// Enabling the digest arms recurring per-comment credit spend — that
		// decision belongs to the owner, not any org member (codeant).
		requireOrgRole(user, 'owner');
		const ch = await ownedChannel(params.id, locals);
		const f = await request.formData();
		const enabled = f.get('enabled') === 'on' ? 1 : 0;
		const cadence = String(f.get('cadence') ?? '');
		if (cadence !== 'weekly' && cadence !== 'per_100' && cadence !== 'manual') {
			return fail(400, { scope: 'settings', error: 'Cadence must be weekly, every 100 comments, or manual.' });
		}
		// Every submitted category must be one of the four — a forged value
		// fails loudly instead of silently dropping out of the mask.
		const rawCategories = f.getAll('category').map(String);
		if (rawCategories.some((c) => !(VALID_CATEGORIES as readonly string[]).includes(c))) {
			return fail(400, { scope: 'settings', error: 'Unknown feedback category.' });
		}
		if (!rawCategories.length) {
			return fail(400, { scope: 'settings', error: 'Pick at least one feedback category.' });
		}
		const categories = VALID_CATEGORIES.filter((c) => rawCategories.includes(c)).join(',');
		const threshold = Number(f.get('threshold'));
		if (!Number.isInteger(threshold) || threshold < 2 || threshold > 10) {
			return fail(400, { scope: 'settings', error: 'Evidence threshold must be a whole number from 2 to 10.' });
		}
		// Org-scoped update: another team's channel matches 0 rows and reads
		// as "not found" — never leak existence.
		const updated = await db
			.update(channels)
			.set({
				feedbackEnabled: enabled,
				feedbackCadence: cadence,
				feedbackCategories: categories,
				feedbackThreshold: threshold
			})
			.where(and(eq(channels.id, params.id), eq(channels.orgId, user.orgId)))
			.returning({ id: channels.id });
		if (!updated.length) return fail(404, { scope: 'settings', error: 'channel not found' });
		return { ok: true, scope: 'settings', message: 'Feedback settings saved.' };
	}
};
