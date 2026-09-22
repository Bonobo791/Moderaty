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

// Deterministic grouping for the creator feedback digest (MOD-69/70). The
// LLM paraphrases each comment's claim to common wording; this module
// groups claims, enforces the evidence threshold, and picks supporting
// comments — pure and side-effect free so identical input always yields an
// identical digest (I4) and the eval harness can run it under plain Node.

import { sanitizeClaim } from './feedbackSanitize.js';

/** Maximum supporting comments persisted per finding. */
export const MAX_EVIDENCE = 5;

/** Default minimum distinct supporters before a theme becomes a finding. */
export const DEFAULT_THRESHOLD = 3;

/**
 * @typedef {object} ClassifiedComment
 * @property {string} commentId - real comments.id this classification came from
 * @property {string} text - raw comment text (for evidence sanitization)
 * @property {string} publishedAt - ISO timestamp; drives recency ordering
 * @property {string} category - 'question' | 'criticism' | 'correction' | 'request' | 'none'
 * @property {boolean} hasAbuse - classifier concealment flag
 * @property {string} claim - neutral claim wording ('' for 'none')
 */

/**
 * @typedef {object} GroupedFinding
 * @property {string} category
 * @property {string} summary - neutral, quantity-qualified, sanitized
 * @property {number} supporterCount - distinct supporting comments
 * @property {ClassifiedComment[]} evidence - ≤ MAX_EVIDENCE, cleanest first
 * @property {string} latestAt - newest publishedAt among supporters
 */

/** @type {Record<string, string>} */
const PER_CATEGORY_VERB = {
	question: 'asked',
	criticism: 'criticized',
	correction: 'corrected',
	request: 'requested'
};

/**
 * Normalizes a claim to its grouping key: lowercase, diacritics stripped,
 * every non-letter/non-number run collapsed to a single space. Unicode
 * letters survive — the prompt instructs claims in the commenter's own
 * language, so an ASCII-only key would normalize an all-Japanese (or
 * Cyrillic, Arabic, …) claim to '' and pool it forever (codeant). The model
 * is instructed to paraphrase to common wording; this key catches the
 * residual case/punctuation drift so the same theme still groups together.
 *
 * @param {string} claim
 * @returns {string}
 */
export function normalizeClaimKey(claim) {
	return claim
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/**
 * Renders the neutral, quantity-qualified summary for a finding.
 *
 * @param {string} category
 * @param {number} supporters
 * @param {string} claim - already sanitized claim text
 * @returns {string}
 */
export function findingSummary(category, supporters, claim) {
	const verb = PER_CATEGORY_VERB[category];
	if (!verb) throw new Error(`findingSummary: unknown category "${category}"`);
	const who = supporters === 1 ? 'One viewer' : `${supporters} viewers`;
	return `${who} ${verb}: ${claim}`;
}

/**
 * Groups classified comments into evidence-backed findings.
 *
 * @param {ClassifiedComment[]} comments - classified comments for one window
 * @param {{ categories?: readonly string[], threshold?: number }} [options] -
 *   `categories` limits which categories may form findings (channel toggle);
 *   `threshold` is the minimum distinct supporter count (default 3).
 * @returns {{ findings: GroupedFinding[], pooled: number }} findings ranked
 *   by supporter count then recency, plus `pooled` — the number of feedback
 *   comments whose themes fell below threshold (the count-only "also seen"
 *   figure; a one-off claim must never surface as a finding).
 */
export function groupFeedback(comments, { categories, threshold = DEFAULT_THRESHOLD } = {}) {
	const enabled = categories ? new Set(categories) : null;
	/** @type {Map<string, { category: string, claim: string, members: Map<string, ClassifiedComment> }>} */
	const groups = new Map();
	let pooled = 0;
	for (const comment of comments) {
		if (comment.category === 'none') continue;
		if (enabled && !enabled.has(comment.category)) {
			// Category toggled off — still feedback, counted as pooled so the
			// digest can report "also seen" without surfacing the theme.
			pooled++;
			continue;
		}
		// The stored claim is sanitized again here — defense in depth: a
		// claim that is nothing but abuse can't headline a finding. Neither
		// can one that normalizes to nothing (pure punctuation, emoji).
		const claim = sanitizeClaim(comment.claim);
		const claimKey = normalizeClaimKey(claim);
		if (!claim || !claimKey) {
			pooled++;
			continue;
		}
		const key = `${comment.category}\u0000${claimKey}`;
		let group = groups.get(key);
		if (!group) {
			group = { category: comment.category, claim, members: new Map() };
			groups.set(key, group);
		}
		// Distinct comment ids only — one comment must never count twice
		// toward its own theme (MOD-70).
		if (!group.members.has(comment.commentId)) group.members.set(comment.commentId, comment);
	}
	/** @type {GroupedFinding[]} */
	const findings = [];
	for (const group of groups.values()) {
		const members = [...group.members.values()];
		if (members.length < threshold) {
			pooled += members.length;
			continue;
		}
		// Evidence favors clean, short examples — the reader should see the
		// clearest supporters first (MOD-70); abusive ones stay available to
		// the reveal path but never lead.
		const ranked = [...members].sort(
			(a, b) =>
				Number(a.hasAbuse) - Number(b.hasAbuse) ||
				a.text.length - b.text.length ||
				Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
				a.commentId.localeCompare(b.commentId)
		);
		const latestAt = members.reduce(
			(max, m) => (Date.parse(m.publishedAt) > Date.parse(max) ? m.publishedAt : max),
			members[0].publishedAt
		);
		findings.push({
			category: group.category,
			summary: findingSummary(group.category, members.length, group.claim),
			supporterCount: members.length,
			evidence: ranked.slice(0, MAX_EVIDENCE),
			latestAt
		});
	}
	findings.sort(
		(a, b) =>
			b.supporterCount - a.supporterCount ||
			Date.parse(b.latestAt) - Date.parse(a.latestAt) ||
			a.summary.localeCompare(b.summary)
	);
	return { findings, pooled };
}
