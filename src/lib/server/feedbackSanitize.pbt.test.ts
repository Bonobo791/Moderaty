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
import { ABUSE_TERMS } from './feedbackLexicon';
import {
	CONCEALED_MESSAGE,
	REDACTION,
	concealEvidence,
	redactAbuse,
	sanitizeClaim
} from './feedbackSanitize';
// Side-effect import: configures fast-check numRuns globally (FC_NUM_RUNS).
import './testarbitraries';

// Single-word, unmasked terms — safe to inject as a standalone word.
const TERM_ARB = fc.constantFrom(
	...ABUSE_TERMS.filter((t) => !t.includes(' ') && !t.includes('*'))
);

test('no leak: redacted output never still contains a lexicon term', () => {
	// Property audit: if a span is missed (bad boundaries, normalization, or
	// splicing), the second pass finds it and this goes red. This is the
	// digest's hard guarantee — concealed output is safe to render raw.
	fc.assert(
		fc.property(fc.string(), (text) => {
			expect(redactAbuse(redactAbuse(text).text).redacted).toBe(0);
		})
	);
});

test('no leak: a standalone abusive word injected into arbitrary text never survives', () => {
	fc.assert(
		fc.property(fc.string(), TERM_ARB, fc.string(), (pre, term, post) => {
			const input = `${pre} ${term} ${post}`;
			const { text } = redactAbuse(input);
			expect(text).not.toContain(term);
			expect(redactAbuse(text).redacted).toBe(0);
		})
	);
});

test('determinism: identical input always produces identical output', () => {
	fc.assert(
		fc.property(fc.string(), fc.boolean(), (text, hasAbuse) => {
			expect(redactAbuse(text)).toEqual(redactAbuse(text));
			expect(concealEvidence(text, { hasAbuse })).toEqual(concealEvidence(text, { hasAbuse }));
		})
	);
});

test('concealment contract: concealed output is the placeholder, revealed output is leak-free', () => {
	// Property audit: if the hasAbuse backstop or the thin-content rule were
	// dropped, an abusive input the lexicon missed would sail through and the
	// unconcealed branch could carry a surviving term — this goes red.
	fc.assert(
		fc.property(fc.string(), fc.boolean(), (text, hasAbuse) => {
			const out = concealEvidence(text, { hasAbuse });
			if (out.concealed) expect(out.text).toBe(CONCEALED_MESSAGE);
			else expect(redactAbuse(out.text).redacted).toBe(0);
		})
	);
});

test('non-marker text is preserved: output minus markers is a subsequence of input', () => {
	// Property audit: if span splicing dropped or reordered unmasked
	// characters, the surviving text would stop being a subsequence of the
	// input — this goes red.
	fc.assert(
		fc.property(fc.string(), (text) => {
			const { text: masked } = redactAbuse(text);
			const kept = masked.split(REDACTION).join('');
			let i = 0;
			for (const ch of kept) {
				i = text.indexOf(ch, i);
				expect(i).toBeGreaterThanOrEqual(0);
				i += 1;
			}
		})
	);
});

test('sanitizeClaim returns either the untouched claim, masked text, or empty', () => {
	fc.assert(
		fc.property(fc.string(), (claim) => {
			const out = sanitizeClaim(claim);
			expect(out === '' || out === claim || redactAbuse(out).redacted === 0).toBe(true);
		})
	);
});
