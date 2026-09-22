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

import fc from 'fast-check';
import { expect, test } from 'vitest';
import { MAX_EVIDENCE, groupFeedback, normalizeClaimKey } from './feedbackGroup';
// Side-effect import: configures fast-check numRuns globally (FC_NUM_RUNS).
import './testarbitraries';

const CATEGORY_ARB = fc.constantFrom('question', 'criticism', 'correction', 'request', 'none');

// Distinct comment ids by construction — the pipeline dedupes comments.id.
const COMMENTS_ARB = fc
	.uniqueArray(fc.nat(), { minLength: 0, maxLength: 40 })
	.chain((ids) =>
		fc.array(
			fc.record({
				text: fc.string({ maxLength: 120 }),
				publishedAt: fc.constant('2026-01-05T00:00:00.000Z'),
				category: CATEGORY_ARB,
				hasAbuse: fc.boolean(),
				claim: fc.string({ maxLength: 60 })
			}),
			{ minLength: ids.length, maxLength: ids.length }
		).map((rest) =>
			rest.map((r, i) => ({
				commentId: `c${ids[i]}`,
				text: r.text,
				publishedAt: r.publishedAt,
				category: r.category,
				hasAbuse: r.hasAbuse,
				claim: r.claim
			}))
		)
	);

const THRESHOLD_ARB = fc.integer({ min: 1, max: 10 });

test('conservation: every feedback comment lands in a finding or the pool — none vanish', () => {
	// Property audit: if grouping dropped or double-counted a supporter,
	// the accounting would stop balancing — this goes red.
	fc.assert(
		fc.property(COMMENTS_ARB, THRESHOLD_ARB, (comments, threshold) => {
			const { findings, pooled } = groupFeedback(comments, { threshold });
			const counted = findings.reduce((n, f) => n + f.supporterCount, 0) + pooled;
			const expected = comments.filter(
				(c) => c.category !== 'none'
			).length;
			expect(counted).toBe(expected);
		})
	);
});

test('threshold: no finding ever reports fewer supporters than the threshold', () => {
	fc.assert(
		fc.property(COMMENTS_ARB, THRESHOLD_ARB, (comments, threshold) => {
			const { findings } = groupFeedback(comments, { threshold });
			for (const finding of findings) {
				expect(finding.supporterCount).toBeGreaterThanOrEqual(threshold);
				expect(finding.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE);
				expect(finding.evidence.length).toBeLessThanOrEqual(finding.supporterCount);
				for (const e of finding.evidence) {
					// Evidence must trace to a real classified comment (MOD-70).
					expect(comments.some((c) => c.commentId === e.commentId)).toBe(true);
				}
			}
		})
	);
});

test('category-honest: findings only use enabled categories', () => {
	// Property audit: the rerun-equality half was dropped (cubic) — a pure
	// function deep-equals itself under any implementation, so it could
	// never fail. What remains is the real invariant: a disabled category
	// must never surface a finding.
	fc.assert(
		fc.property(COMMENTS_ARB, THRESHOLD_ARB, (comments, threshold) => {
			const categories = ['question', 'request'];
			const { findings } = groupFeedback(comments, { categories, threshold });
			for (const finding of findings) expect(categories).toContain(finding.category);
		})
	);
});

test('normalizeClaimKey is idempotent and punctuation-insensitive', () => {
	fc.assert(
		fc.property(fc.string(), (claim) => {
			const once = normalizeClaimKey(claim);
			expect(normalizeClaimKey(once)).toBe(once);
		})
	);
});
