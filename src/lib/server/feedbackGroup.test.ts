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

import { describe, expect, test } from 'vitest';
import {
	DEFAULT_THRESHOLD,
	MAX_EVIDENCE,
	findingSummary,
	groupFeedback,
	normalizeClaimKey
} from './feedbackGroup';

/** @param {Partial<import('./feedbackGroup').ClassifiedComment> & { commentId: string }} over */
function comment(over: { commentId: string } & Record<string, unknown>) {
	return {
		text: `text of ${over.commentId}`,
		publishedAt: '2026-01-05T00:00:00.000Z',
		category: 'question',
		hasAbuse: false,
		claim: 'when is the next video',
		...over
	};
}

function supporters(claim: string, n: number, prefix = 'c', over: Record<string, unknown> = {}) {
	return Array.from({ length: n }, (_, i) =>
		comment({ commentId: `${prefix}${i}`, claim, ...over })
	);
}

describe('normalizeClaimKey', () => {
	test('folds case, punctuation, and diacritics to one key', () => {
		expect(normalizeClaimKey('When is the NEXT video?!')).toBe(normalizeClaimKey('when is the next video'));
		expect(normalizeClaimKey('o áudio está alto')).toBe('o audio esta alto');
	});

	test('keeps non-Latin letters — a claim written entirely in another script still has a key', () => {
		// The prompt instructs claims in the commenter's own language; an
		// ASCII-only key normalizes them to '' and pools every one forever
		// (codeant).
		expect(normalizeClaimKey('字幕を付けてください')).not.toBe('');
		expect(normalizeClaimKey('добавьте субтитры')).not.toBe('');
	});
});

describe('groupFeedback', () => {
	test('groups same-theme comments into one finding per category', () => {
		const { findings } = groupFeedback([
			...supporters('when is the next video', 3),
			...supporters('when is the next video?', 2, 'd'), // punctuation drift groups with the first
			...supporters('the audio is loud', 3, 'a', { category: 'criticism' })
		]);
		expect(findings).toHaveLength(2);
		expect(findings[0]).toMatchObject({ category: 'question', supporterCount: 5 });
		expect(findings[0].summary).toBe('5 comments asked: when is the next video');
		expect(findings[1]).toMatchObject({ category: 'criticism', supporterCount: 3 });
	});

	test('drops below-threshold themes into the pooled count', () => {
		const { findings, pooled } = groupFeedback([
			...supporters('one-off question', 1),
			...supporters('another lone question', 2, 'd'),
			...supporters('a popular request', 4, 'r', { category: 'request' })
		]);
		expect(findings).toHaveLength(1);
		expect(findings[0].category).toBe('request');
		// 1 + 2 sub-threshold supporters pool into the count-only line.
		expect(pooled).toBe(3);
	});

	test('a lone comment never becomes a finding at the default threshold', () => {
		const { findings, pooled } = groupFeedback([comment({ commentId: 'solo', category: 'correction', claim: 'the spec is wrong' })]);
		expect(findings).toEqual([]);
		expect(pooled).toBe(1);
	});

	test('none-category comments are excluded entirely, never pooled', () => {
		const { findings, pooled } = groupFeedback([
			comment({ commentId: 'n1', category: 'none', claim: '' }),
			comment({ commentId: 'n2', category: 'none', claim: '', hasAbuse: true }),
			...supporters('what mic do you use', 3)
		]);
		expect(findings).toHaveLength(1);
		expect(pooled).toBe(0);
	});

	test('a comment cannot count twice toward its own theme', () => {
		// Same commentId twice must not inflate the supporter count.
		const dup = comment({ commentId: 'same-id' });
		const { findings, pooled } = groupFeedback([dup, dup, dup]);
		expect(findings).toEqual([]);
		expect(pooled).toBe(1);
	});

	test('honors a custom evidence threshold', () => {
		const comments = supporters('borderline theme', 2);
		expect(groupFeedback(comments, { threshold: 2 }).findings).toHaveLength(1);
		expect(groupFeedback(comments, { threshold: 3 }).findings).toHaveLength(0);
	});

	test('honors the channel category mask', () => {
		const { findings, pooled } = groupFeedback(
			[
				...supporters('a question', 3),
				...supporters('a request', 3, 'r', { category: 'request' })
			],
			{ categories: ['question'] }
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].category).toBe('question');
		expect(pooled).toBe(3); // requests were feedback, just toggled off
	});

	test('caps evidence at MAX_EVIDENCE and prefers clean, short supporters first', () => {
		const members = supporters('popular claim', 8);
		members[0].hasAbuse = true; // abusive supporter sinks below clean ones
		const { findings } = groupFeedback(members);
		expect(findings[0].evidence).toHaveLength(MAX_EVIDENCE);
		expect(findings[0].evidence.every((e) => !e.hasAbuse)).toBe(true);
		expect(findings[0].supporterCount).toBe(8);
	});

	test('ranks findings by supporter count then recency', () => {
		const { findings } = groupFeedback([
			...supporters('older theme', 3, 'a', { publishedAt: '2026-01-01T00:00:00.000Z' }),
			...supporters('newest theme', 3, 'b', { publishedAt: '2026-01-07T00:00:00.000Z' }),
			...supporters('biggest theme', 4, 'c')
		]);
		expect(findings.map((f) => f.supporterCount)).toEqual([4, 3, 3]);
		expect(findings[1].summary).toContain('newest theme');
		expect(findings[2].summary).toContain('older theme');
	});

	test('recency compares instants — an offset timestamp sorting later as text is still older', () => {
		// '2026-01-07T01:00:00+05:30' is 2026-01-06T19:30:00Z: lexically it
		// sorts AFTER '2026-01-06T23:00:00.000Z' but its instant is EARLIER —
		// a text compare would rank the wrong theme as newest (codeant).
		const { findings } = groupFeedback([
			...supporters('offset theme', 3, 'a', { publishedAt: '2026-01-07T01:00:00+05:30' }),
			...supporters('truly newest theme', 3, 'b', { publishedAt: '2026-01-06T23:00:00.000Z' })
		]);
		expect(findings[0].summary).toContain('truly newest theme');
		expect(findings[0].latestAt).toBe('2026-01-06T23:00:00.000Z');
	});

	test('non-Latin claims group into a finding instead of pooling', () => {
		const { findings, pooled } = groupFeedback(
			supporters('字幕を付けてください', 3, 'j', { category: 'request' })
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].supporterCount).toBe(3);
		expect(pooled).toBe(0);
	});

	test('a claim that is nothing but abuse drops to the pool instead of headlining a finding', () => {
		const { findings, pooled } = groupFeedback(
			supporters('fuck this shit', 3, 'a', { category: 'criticism', hasAbuse: true })
		);
		expect(findings).toEqual([]);
		expect(pooled).toBe(3);
	});

	test('is deterministic — identical input produces identical findings', () => {
		const comments = [
			...supporters('theme one', 4, 'a'),
			...supporters('theme two', 3, 'b', { category: 'request' })
		];
		expect(groupFeedback(comments)).toEqual(groupFeedback(comments));
	});
});

describe('findingSummary', () => {
	test('quantity-qualifies singular and plural', () => {
		expect(findingSummary('question', 1, 'the claim')).toBe('One comment asked: the claim');
		expect(findingSummary('request', 7, 'the claim')).toBe('7 comments requested: the claim');
	});

	test('throws on an unknown category rather than writing a misleading summary', () => {
		expect(() => findingSummary('spam', 3, 'x')).toThrow();
	});
});
