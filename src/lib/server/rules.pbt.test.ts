// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// Property tests for rules.ts (I6). recheck is the REAL oracle — never mocked
// here: the property cross-checks validateRule's accept/reject verdict against
// checkSync on fully generated patterns. No database, no other mocks.

import fc from 'fast-check';
import { checkSync } from 'recheck';
import { expect, test, vi } from 'vitest';
import { matchRule, validateRule, type RuleRow } from './rules';
import './testarbitraries'; // global fast-check numRuns config (FC_NUM_RUNS)

test('I6 dichotomy: validateRule never accepts a pattern recheck cannot prove safe', () => {
	// Property audit: dropping the recheck guard (accepting checkSync status
	// !== 'safe') accepts generated unsafe patterns — the accepted ⇒ 'safe'
	// assertion goes red. Accepting an over-length pattern breaks the ≤256
	// assertion; swallowing a compile error breaks the RegExp assertion.
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); // loud channel, silenced for burn-in readability
	try {
		fc.assert(
			// ≤300 by construction: sweeps both sides of the 256-char cap without
			// pathological recheck runtimes.
			fc.property(fc.string({ maxLength: 300 }), (pattern) => {
				const rule: RuleRow = { id: 1, type: 'regex', pattern, action: 'hold' };
				let accepted = false;
				try {
					validateRule(rule);
					accepted = true;
				} catch {
					accepted = false;
				}
				let recheckStatus: string;
				try {
					recheckStatus = checkSync(pattern, 'i').status;
				} catch {
					recheckStatus = 'error';
				}
				if (accepted) {
					// Oracle direction: accepted ⇒ compilable as the code compiles it,
					// within the cap, and recheck agrees safe. Never accepted-unsafe.
					expect(() => {
						// nosemgrep: fuzzed pattern — this assertion exists to prove validateRule only accepts compilable patterns.
						new RegExp(pattern, 'i');
					}).not.toThrow();
					expect(pattern.length).toBeLessThanOrEqual(256);
					expect(recheckStatus).toBe('safe');
				} else {
					// Rejection while recheck-safe is legitimate (the syntax guards —
					// backreferences, duplicate alternation — are stricter than
					// recheck), so nothing is asserted on that side. (The old
					// `expect(accepted).toBe(false)` here was vacuous — the branch
					// already implies it.)
				}
			})
		);
	} finally {
		warnSpy.mockRestore();
	}
});

/** ASCII-only keywords: per-character case swapping round-trips cleanly (no ß/İ surprises). */
const keywordArb = fc.stringMatching(/^[A-Za-z0-9 ]{1,30}$/);

/** A keyword plus a per-character casing mask and arbitrary surrounding text. */
const keywordRunArb = keywordArb.chain((pattern) =>
	fc.record({
		pattern: fc.constant(pattern),
		casing: fc.array(fc.boolean(), { minLength: pattern.length, maxLength: pattern.length }),
		prefix: fc.string({ maxLength: 20 }),
		suffix: fc.string({ maxLength: 20 })
	})
);

test('keyword rules match case-insensitively across generated pattern/text casing', () => {
	// Property audit: dropping the text-side toLowerCase (matching against raw
	// text) or the pattern-side toLowerCase (lowercasing raw pattern only)
	// misses generated mixed-case combinations — the match assertion goes red.
	fc.assert(
		fc.property(keywordRunArb, ({ pattern, casing, prefix, suffix }) => {
			const cased = [...pattern]
				.map((character, index) => (casing[index] ? character.toUpperCase() : character.toLowerCase()))
				.join('');
			const rule: RuleRow = { id: 1, type: 'keyword', pattern, action: 'hold' };
			expect(matchRule(prefix + cased + suffix, 'UC-author', [rule])).toEqual(rule);
		})
	);
});
