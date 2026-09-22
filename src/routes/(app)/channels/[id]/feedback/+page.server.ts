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

import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';

import { db } from '$lib/server/db';
import { channels, feedbackDigests, feedbackFindings, findingEvidence } from '$lib/server/db/schema';
import { enabledCategories, generateFeedbackDigest, type DigestResult } from '$lib/server/feedbackDigest';
import { ownedChannel, requireOrgRole } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';

/** The four digest categories, in display order — the only values accepted by the settings form. */
const VALID_CATEGORIES = ['question', 'criticism', 'correction', 'request'] as const;

/** Manual runs share the cron bounding idea: a hard ceiling, then a clean defer. */
const MANUAL_RUN_BUDGET_MS = 15_000;

export async function load({ params, locals }) {
	// Database outage: the layout renders the overlay; this load must not 401
	// on the null-user outage shape.
	if (locals.dbDown) return { ch: { id: params.id, title: '' }, maintenance: true };
	const ch = await ownedChannel(params.id, locals);
	const digestFields = {
		id: feedbackDigests.id,
		windowStart: feedbackDigests.windowStart,
		windowEnd: feedbackDigests.windowEnd,
		status: feedbackDigests.status,
		commentsClassified: feedbackDigests.commentsClassified,
		commentsFailed: feedbackDigests.commentsFailed,
		pooledCount: feedbackDigests.pooledCount,
		creditsUsed: feedbackDigests.creditsUsed,
		error: feedbackDigests.error,
		createdAt: feedbackDigests.createdAt
	} as const;
	const [digests, latest] = await Promise.all([
		db
			.select(digestFields)
			.from(feedbackDigests)
			.where(eq(feedbackDigests.channelId, params.id))
			// id is monotonic — createdAt can tie within a millisecond (cubic).
			.orderBy(desc(feedbackDigests.id))
			.limit(10)
			.all(),
		// The newest COMPLETE digest must come from its own query: a streak of
		// failed rows can push it out of the 10-row history page entirely, and
		// deriving it from that page would make the UI claim none exists
		// (codex).
		db
			.select(digestFields)
			.from(feedbackDigests)
			.where(and(eq(feedbackDigests.channelId, params.id), eq(feedbackDigests.status, 'complete')))
			.orderBy(desc(feedbackDigests.id))
			.limit(1)
			.get()
	]);
	// A newer failed/deferred row still surfaces as the status banner (never
	// silently stale) while the page renders the last good digest.
	const latestComplete = latest ?? null;
	let findings: {
		id: number;
		category: string;
		summary: string;
		supporterCount: number;
		evidence: { id: number; sanitizedExcerpt: string; hasAbuse: number }[];
	}[] = [];
	if (latestComplete) {
		const rows = await db
			.select()
			.from(feedbackFindings)
			.where(eq(feedbackFindings.digestId, latestComplete.id))
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
		ch: { id: ch.id, title: ch.title },
		digests,
		latest: latestComplete,
		findings,
		settings: {
			enabled: ch.feedbackEnabled === 1,
			cadence: ch.feedbackCadence ?? 'weekly',
			categories: enabledCategories(ch),
			threshold: ch.feedbackThreshold ?? 3
		}
	};
}

export const actions = {
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
			ch.feedbackCadence === 'manual'
				? 'retry with Generate now.'
				: 'it will retry on the next cron tick.';
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
						message: `Digest generated — ${result.findings} finding(s) from ${result.commentsClassified} comment(s).`
					};
				case 'empty':
					return { ok: true, scope: 'digest', message: 'No new comments since the last digest window.' };
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
