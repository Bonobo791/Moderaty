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

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';

import { db } from '$lib/server/db';
import { channels, feedbackDigests, feedbackFindings, findingEvidence } from '$lib/server/db/schema';
import { enabledCategories, generateFeedbackDigest } from '$lib/server/feedbackDigest';
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
	const digests = await db
		.select({
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
		})
		.from(feedbackDigests)
		.where(eq(feedbackDigests.channelId, params.id))
		.orderBy(desc(feedbackDigests.createdAt))
		.limit(10)
		.all();
	// The page renders the newest COMPLETE digest; a newer failed/deferred row
	// still surfaces as the status banner (never silently stale).
	const latest = digests.find((d) => d.status === 'complete') ?? null;
	let findings: {
		id: number;
		category: string;
		summary: string;
		supporterCount: number;
		evidence: { id: number; sanitizedExcerpt: string; hasAbuse: number }[];
	}[] = [];
	if (latest) {
		const rows = await db
			.select()
			.from(feedbackFindings)
			.where(eq(feedbackFindings.digestId, latest.id))
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
		latest,
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
	/** "Generate now" — a forced run over the window since the last complete digest. */
	generate: async ({ params, locals }) => {
		// A run spends org credits on metered plans — owner-only like every
		// money-moving action; membership alone is not enough (codeant).
		requireOrgRole(requireUser(locals), 'owner');
		const ch = await ownedChannel(params.id, locals);
		if (ch.feedbackEnabled !== 1) {
			return fail(400, { scope: 'digest', error: 'Enable the feedback digest below before generating.' });
		}
		let result;
		try {
			result = await generateFeedbackDigest(params.id, { force: true, deadline: Date.now() + MANUAL_RUN_BUDGET_MS });
		} catch (e) {
			// Loud server-side, generic client-side — raw provider detail never
			// reaches the browser.
			console.error('manual feedback digest failed for channel:', params.id, e);
			return fail(502, { scope: 'digest', error: 'Digest generation failed — check the server log and try again.' });
		}
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
					error: `Generation deferred (${result.reason ?? 'busy'}) — it will retry on the next cron tick.`
				});
			case 'skipped':
				return fail(409, { scope: 'digest', error: 'The channel is paused — resume it before generating.' });
			default:
				return fail(502, {
					scope: 'digest',
					error: `Digest generation failed (${result.reason ?? 'error'}) — it will retry on the next cron tick.`
				});
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
