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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { expect, test, vi } from 'vitest';
import { matchPreparedRule, matchRule, prepareRules, validateRule } from './rules';

// recheck is passed through to the real implementation by default; individual
// tests can force a failure to exercise the loud-rejection fallback (I6).
const recheckState = vi.hoisted(() => ({ error: null as unknown }));
vi.mock('recheck', async (importOriginal) => {
	const real = await importOriginal<typeof import('recheck')>();
	return {
		checkSync: vi.fn((...args: Parameters<typeof real.checkSync>) => {
			if (recheckState.error) throw recheckState.error;
			return real.checkSync(...args);
		})
	};
});

test('matches keyword, user ID, and regex rules', () => {
	const keyword = { id: 1, type: 'keyword', pattern: 'spam', action: 'hold' };
	const user = { id: 2, type: 'user', pattern: 'UC-author', action: 'reject' };
	const regex = { id: 3, type: 'regex', pattern: 'buy\\s+now', action: 'delete' };

	expect(matchRule('This is SPAM', 'other', [keyword])).toBe(keyword);
	expect(matchRule('A normal comment', 'UC-author', [user])).toBe(user);
	expect(matchRule('BUY now!', 'other', [regex])).toBe(regex);
	expect(matchRule('A normal comment', 'other', [keyword, user, regex])).toBeNull();
});

test('rejects invalid stored rules', () => {
	expect(() => matchRule('text', 'author', [{ id: 2, type: 'regex', pattern: '(', action: 'hold' }])).toThrow(
		/rule #2 has an invalid regex/
	);
	expect(() => matchRule('text', 'author', [{ id: 3, type: 'unknown', pattern: 'text', action: 'hold' }])).toThrow(
		/rule #3 has an unsupported type/
	);
	expect(() => matchRule('text', 'author', [{ id: 4, type: 'keyword', pattern: 'text', action: 'archive' }])).toThrow(
		/rule #4 has an unsupported action/
	);
	expect(() => matchRule('text', 'author', [{ id: 5, type: 'regex', pattern: '(a|a)+', action: 'hold' }])).toThrow(
		/rule #5 has an unsafe regex/
	);
	expect(() => matchRule('aa', 'author', [{ id: 6, type: 'regex', pattern: '(?<word>a+)\\k<word>', action: 'hold' }])).toThrow(
		/rule #6 has an unsafe regex/
	);
	expect(() => matchRule('text', 'author', [{ id: 7, type: 'regex', pattern: '(a|a)+', action: 'hold' }])).toThrow(
		/rule #7 has an unsafe regex/
	);
	expect(() => matchRule('text', 'author', [{ id: 8, type: 'regex', pattern: '(a|ab)*c', action: 'hold' }])).toThrow(
		/rule #8 has an unsafe regex/
	);
});

test('accepts regex rules without overlapping alternation', () => {
	const alternation = { id: 9, type: 'regex', pattern: '(cat|dog)+', action: 'hold' };
	expect(matchRule('catcatdog', 'author', [alternation])).toBe(alternation);
});

test('validates malformed rows before touching their pattern during ordering', () => {
	// A malformed stored row (e.g. NULL pattern from a bad import) must surface the
	// descriptive validation error, not a raw TypeError from the specificity sort.
	const malformed = { id: 12, type: 'keyword', pattern: null as unknown as string, action: 'hold' };
	const valid = { id: 13, type: 'keyword', pattern: 'spam', action: 'hold' };
	expect(() => matchRule('text', 'author', [malformed, valid])).toThrow(/rule #12 has an empty pattern/);
});

test('matches keyword rules case-insensitively on the stored pattern too', () => {
	// A stored uppercase pattern must still match lowercase comment text —
	// dropping the pattern-side lowercase silently disables the rule.
	const upper = { id: 20, type: 'keyword', pattern: 'SPAM', action: 'hold' };
	expect(matchRule('this is spam', 'author', [upper])).toBe(upper);
});

test('most specific pattern wins regardless of stored order', () => {
	const broad = { id: 10, type: 'keyword', pattern: 'fuck', action: 'hold' };
	const specific = { id: 11, type: 'keyword', pattern: 'fuck you', action: 'reject' };
	expect(matchRule('well fuck you too', 'author', [broad, specific])).toBe(specific);
	expect(matchRule('well fuck you too', 'author', [specific, broad])).toBe(specific);
	expect(matchRule('what the fuck', 'author', [broad, specific])).toBe(broad);
});

test('an escaped pipe does not split alternatives in duplicate detection', () => {
	// Body `\|a|a`: the first `|` is escaped, so the alternatives are `\|a` and
	// `a` — not duplicates. Treating the backslash (or the leading character)
	// as already-consumed splits at the escaped pipe and reports a false
	// duplicate, rejecting a safe rule.
	const escapedPipe = { id: 30, type: 'regex', pattern: '(\\|a|a)', action: 'hold' };
	expect(matchRule('a literal |a here', 'author', [escapedPipe])).toBe(escapedPipe);
	// Body `\x|a|a`: the escaped `x` is consumed once, so the pipes split and the
	// duplicate `a|a` is caught; leaving the escaped flag set after consuming it
	// would swallow the first pipe and miss the duplicate.
	expect(() => matchRule('text', 'author', [{ id: 60, type: 'regex', pattern: '(\\x|a|a)', action: 'hold' }])).toThrow(
		/rule #60 has an unsafe regex/
	);
});

test('duplicate alternatives inside a character class are still compared as whole alternatives', () => {
	// Body `[|]|[|]`: the pipes inside the classes must not split; the two
	// identical `[|]` alternatives are a real duplicate and unsafe.
	expect(() => matchRule('text', 'author', [{ id: 31, type: 'regex', pattern: '([|]|[|])', action: 'hold' }])).toThrow(
		/rule #31 has an unsafe regex/
	);
});

test('pipes inside character classes do not split alternatives', () => {
	// Body `[a|b]x[a|b]x[a|b]`: every pipe is inside a class, so there is a
	// single alternative — no duplicate. Splitting at class pipes fabricates
	// the fragment `b]x[a` twice and reports a false duplicate.
	const classes = { id: 32, type: 'regex', pattern: '([a|b]x[a|b]x[a|b])', action: 'hold' };
	expect(matchRule('axaxax', 'author', [classes])).toBe(classes);
});

test('nested group pipes do not split top-level alternatives', () => {
	// Body `[(]|a|a`: the `(` is inside a class and must not bump the depth, so
	// both outer pipes split and the duplicate `a|a` is caught. Skipping the
	// class entirely would leave depth > 0 and miss it.
	expect(() => matchRule('text', 'author', [{ id: 33, type: 'regex', pattern: '([(]|a|a)', action: 'hold' }])).toThrow(
		/rule #33 has an unsafe regex/
	);
	// Body `(a)|b|b`: after the group closes, depth returns to 0 and the pipes
	// split, catching `b|b`. Mishandling `(`/`)` depth leaves depth > 0.
	expect(() => matchRule('text', 'author', [{ id: 34, type: 'regex', pattern: '((a)|b|b)', action: 'hold' }])).toThrow(
		/rule #34 has an unsafe regex/
	);
});

test('pipes inside nested groups do not split alternatives', () => {
	// Body `(a|b)x(a|b)x(a|b)`: no top-level pipe, so a single alternative and
	// no duplicate. Splitting at nested pipes fabricates the fragment `b)x(a`
	// twice and reports a false duplicate.
	const nested = { id: 35, type: 'regex', pattern: '((a|b)x(a|b)x(a|b))', action: 'hold' };
	expect(matchRule('axaxax', 'author', [nested])).toBe(nested);
});

test('distinct alternatives of the same length are not duplicates', () => {
	// Body `aX|aY`: two distinct alternatives — safe. Splitting at every
	// character position fabricates a duplicate single-character alternative.
	const distinct = { id: 36, type: 'regex', pattern: '(aX|aY)', action: 'hold' };
	expect(matchRule('aX and aY', 'author', [distinct])).toBe(distinct);
});

test('rejects numeric backreferences', () => {
	expect(() => matchRule('aa', 'author', [{ id: 37, type: 'regex', pattern: '(a)\\1', action: 'hold' }])).toThrow(
		/rule #37 has an unsafe regex/
	);
});

test('escaped character classes are not backreferences', () => {
	// `\d` is an escaped `d`, not a backreference; treating every escaped
	// character as unsafe rejects a safe rule.
	const digit = { id: 38, type: 'regex', pattern: '\\d+', action: 'hold' };
	expect(matchRule('12345', 'author', [digit])).toBe(digit);
	// `\d<`: an escaped character followed by `<` is still not a backreference;
	// only `\k<` introduces one.
	const digitLt = { id: 61, type: 'regex', pattern: '\\d<', action: 'hold' };
	expect(matchRule('a 5< here', 'author', [digitLt])).toBe(digitLt);
});

test('an escaped k without a following < is not a backreference', () => {
	// `\k` alone is a literal `k` (Annex B identity escape); only `\k<` starts
	// a named backreference.
	const literalK = { id: 39, type: 'regex', pattern: '\\k', action: 'hold' };
	expect(matchRule('ok', 'author', [literalK])).toBe(literalK);
	// `\k<w>` has the named-backreference shape and is rejected even though no
	// named group exists and recheck itself reports the pattern safe.
	expect(() => matchRule('k<w>', 'author', [{ id: 62, type: 'regex', pattern: '\\k<w>', action: 'hold' }])).toThrow(
		/rule #62 has an unsafe regex/
	);
});

test('a literal backslash before k< is not a backreference', () => {
	// `\\k<`: the escaped backslash is consumed first, so the `k` is a plain
	// character; leaving the escaped flag set after consuming it would treat
	// the `k` as a `\k<` backreference and reject a safe rule.
	const literalBackslash = { id: 40, type: 'regex', pattern: '\\\\k<', action: 'hold' };
	expect(matchRule('a \\k< here', 'author', [literalBackslash])).toBe(literalBackslash);
});

test('unbalanced group closers inside character classes do not pair with real groups', () => {
	// `(a|a[)])`: the `)` inside the class must be ignored, so the single real
	// group body is `a|a[)]` — distinct alternatives, safe. Tracking it pops
	// the real opener early and reports a false `a|a` duplicate.
	const classCloser = { id: 41, type: 'regex', pattern: '(a|a[)])', action: 'hold' };
	expect(matchRule('aaa', 'author', [classCloser])).toBe(classCloser);
	// `([)]|a|a)`: the `)` inside the class is ignored, so the group body is
	// `[)]|a|a` and the duplicate `a|a` is caught. Ignoring class brackets (or
	// the class state) pairs the class `)` with the opener and misses it.
	expect(() => matchRule('text', 'author', [{ id: 63, type: 'regex', pattern: '([)]|a|a)', action: 'hold' }])).toThrow(
		/rule #63 has an unsafe regex/
	);
});

test('leaving a character class re-enables group tracking', () => {
	// `[a](b|b)`: after the class closes, the group is tracked again and its
	// duplicate alternatives are caught. Never leaving the class misses it.
	expect(() => matchRule('text', 'author', [{ id: 42, type: 'regex', pattern: '[a](b|b)', action: 'hold' }])).toThrow(
		/rule #42 has an unsafe regex/
	);
});

test('group prefixes are stripped before comparing alternatives', () => {
	// `(?:a|a)`: the `?:` prefix is not part of the first alternative; without
	// stripping it the `a|a` duplicate is missed.
	expect(() => matchRule('text', 'author', [{ id: 43, type: 'regex', pattern: '(?:a|a)', action: 'hold' }])).toThrow(
		/rule #43 has an unsafe regex/
	);
});

test('named-group prefixes are stripped regardless of the identifier start character', () => {
	// recheck dedupes the identical `a|a` branches and reports them safe, so
	// duplicate-alternation detection is the only guard. The named-group prefix
	// must be stripped even when the name starts with `_`, `$`, or a non-ASCII
	// letter, or `(?<_a>a|a)+` slips past as "safe".
	for (const [index, name] of ['_a', '$a', 'é'].entries()) {
		const id = 70 + index;
		expect(() =>
			matchRule('text', 'author', [{ id, type: 'regex', pattern: `(?<${name}>a|a)+`, action: 'hold' }])
		).toThrow(new RegExp(`rule #${id} has an unsafe regex`));
	}
});

test('rejects patterns over the maximum length but accepts the boundary', () => {
	expect(() =>
		matchRule('text', 'author', [{ id: 44, type: 'regex', pattern: 'a'.repeat(257), action: 'hold' }])
	).toThrow(/rule #44 has an unsafe regex/);
	const atMax = { id: 45, type: 'regex', pattern: 'a'.repeat(256), action: 'hold' };
	expect(matchRule('a'.repeat(300), 'author', [atMax])).toBe(atMax);
});

test('rejects an oversized INVALID pattern as unsafe before the RegExp constructor runs', () => {
	// Length-first (I6): a 257-char pattern that is also syntactically invalid
	// must be rejected by the LENGTH guard, not by the compile step.
	const oversizedInvalid = '(' + 'a'.repeat(256);
	expect(() =>
		matchRule('text', 'author', [{ id: 48, type: 'regex', pattern: oversizedInvalid, action: 'hold' }])
	).toThrow(/rule #48 has an unsafe regex/);
});

test('recheck analyzes patterns with the case-insensitive flag', async () => {
	const { checkSync: mockedCheckSync } = await import('recheck');
	vi.mocked(mockedCheckSync).mockClear();
	const rule = { id: 46, type: 'regex', pattern: 'abc', action: 'hold' };
	expect(matchRule('ABC', 'author', [rule])).toBe(rule);
	expect(mockedCheckSync).toHaveBeenCalledWith('abc', 'i');
});

test('a recheck failure rejects the pattern loudly as unsafe', async () => {
	const { checkSync: mockedCheckSync } = await import('recheck');
	const failure = new Error('recheck exploded');
	recheckState.error = failure;
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		expect(() => matchRule('text', 'author', [{ id: 47, type: 'regex', pattern: 'abc', action: 'hold' }])).toThrow(
			/rule #47 has an unsafe regex/
		);
		expect(warn).toHaveBeenCalledWith(
			'recheck could not analyze a rule pattern; rejecting it as unsafe:',
			failure
		);
		expect(mockedCheckSync).toHaveBeenCalledWith('abc', 'i');
	} finally {
		recheckState.error = null;
		warn.mockRestore();
	}
});

test('validateRule accepts valid rules and validates regex patterns only for regex rules', () => {
	expect(() => validateRule({ id: 50, type: 'keyword', pattern: 'spam', action: 'hold' })).not.toThrow();
	expect(() => validateRule({ id: 51, type: 'user', pattern: 'UC-author', action: 'reject' })).not.toThrow();
	expect(() => validateRule({ id: 52, type: 'regex', pattern: 'buy\\s+now', action: 'delete' })).not.toThrow();
	expect(() => validateRule({ id: 53, type: 'regex', pattern: '(a|a)+', action: 'hold' })).toThrow(
		/rule #53 has an unsafe regex/
	);
	// A keyword pattern that would be an invalid regex must pass: only regex
	// rules have their patterns compiled and safety-checked.
	expect(() => validateRule({ id: 54, type: 'keyword', pattern: '(', action: 'hold' })).not.toThrow();
});

test('prepareRules compiles regexes only for regex rules', () => {
	const keyword = { id: 55, type: 'keyword', pattern: '(', action: 'hold' };
	const regexRule = { id: 56, type: 'regex', pattern: 'buy\\s+now', action: 'delete' };
	const prepared = prepareRules([keyword, regexRule]);
	expect(prepared.find((p) => p.rule === keyword)?.compiled).toBeNull();
	expect(prepared.find((p) => p.rule === regexRule)?.compiled).toBeInstanceOf(RegExp);
});

test('user rules match only the author, keyword rules only the text', () => {
	const userRule = { id: 57, type: 'user', pattern: 'UC-spammer', action: 'reject' };
	// The comment text containing the pattern must not trigger a user rule.
	expect(matchRule('UC-spammer wrote this', 'UC-innocent', [userRule])).toBeNull();
	// A user rule must not match a different author.
	expect(matchRule('a normal comment', 'UC-innocent', [userRule])).toBeNull();
	const prepared = prepareRules([userRule]);
	expect(matchPreparedRule('UC-spammer wrote this', 'UC-innocent', prepared)).toBeNull();
	expect(matchPreparedRule('a normal comment', 'UC-spammer', prepared)).toBe(userRule);
	// A keyword rule whose pattern equals the author ID matches on the text
	// only — never on the author alone.
	const keywordRule = { id: 64, type: 'keyword', pattern: 'UC-author', action: 'hold' };
	expect(matchRule('a normal comment', 'UC-author', [keywordRule])).toBeNull();
});
