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

// Deterministic concealment for digest evidence (MOD-68). Redaction NEVER
// relies on the LLM: a lexicon pass masks known abusive spans to a fixpoint
// (one mask can bridge a multi-word insult back into view — "shut fuck up"
// leaves "shut █ up"), the classifier's hasAbuse flag conceals the comment
// outright — the lexicon can never prove it caught everything the
// classifier saw — and a thin-content rule conceals comments that are
// mostly mask anyway. Rendered digests only ever see this output.

import { ABUSE_TERMS } from './feedbackLexicon.js';

/** Mask substituted for each abusive span. */
export const REDACTION = '█████';

/** Placeholder for evidence whose wording cannot be shown safely. */
export const CONCEALED_MESSAGE = '[concealed]';

// Common leetspeak/lookalike substitutions folded onto their base letter so
// "f*ck" variants and "5h1t" still match the lexicon. '*' stays literal so
// the masked entries ("f*ck") match too.
/** @type {Record<string, string>} */
const LEET = {
	'0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
	'@': 'a', '$': 's', '!': 'i', '€': 'e', '£': 'l', '+': 't'
};

/**
 * Builds a normalized copy of the text for matching, plus a map back to the
 * original offsets. Normalization: NFKD → strip combining marks →
 * lowercase → leet fold → every char that isn't [a-z0-9*] becomes a space.
 *
 * @param {string} text
 * @returns {{ norm: string, map: number[] }} map[i] is the UTF-16 offset in
 *   `text` that produced norm[i].
 */
function normalizeWithMap(text) {
	let norm = '';
	const map = [];
	for (let i = 0; i < text.length; i++) {
		// NFKD splits accented chars into base + combining marks; the marks
		// are dropped below, leaving the ascii base letter.
		for (const part of text[i].normalize('NFKD')) {
			const c = part.toLowerCase();
			if (/[\u0300-\u036f]/.test(c)) continue;
			const folded = LEET[c] ?? c;
			const out = /[a-z0-9*]/.test(folded) ? folded : ' ';
			norm += out;
			map.push(i);
		}
	}
	return { norm, map };
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Real-world masking replaces a vowel with '*': "f*ck", "sh*t", "b*tch".
// Generate every single-vowel-masked variant so the writer's obfuscation
// can't pick the one vowel we didn't list. '*' survives normalization
// literally, so these entries match the typed text exactly.
/** @param {readonly string[]} terms */
function withMaskedVowelVariants(terms) {
	const out = new Set(terms);
	for (const term of terms) {
		for (let i = 0; i < term.length; i++) {
			if ('aeiou'.includes(term[i])) out.add(term.slice(0, i) + '*' + term.slice(i + 1));
		}
	}
	return out;
}

const ALL_TERMS = withMaskedVowelVariants(ABUSE_TERMS);

// One compiled matcher over the whole lexicon: alternation on normalized
// terms, boundaries on both ends so substrings of longer words never match
// ("class" ≠ "ass", "computar" ≠ "puta"). Boundaries are custom because '*'
// is a word edge here, not a \w char. Spaces inside multi-word terms match
// one-or-more whitespace chars — normalization can emit runs of them.
const ABUSE_RE = new RegExp(
	`(?<![a-z0-9*])(?:${[...ALL_TERMS]
		.map((t) => escapeRe(t).replace(/ /g, '\\s+'))
		.join('|')})(?![a-z0-9*])`,
	'gi'
);

/**
 * Redacts lexicon hits in-place, preserving the original casing/punctuation
 * around them. Pure and deterministic — safe for property tests.
 *
 * @param {string} text
 * @returns {{ text: string, redacted: number }} the masked text and the
 *   number of spans that were masked.
 */
export function redactAbuse(text) {
	if (!text) return { text: '', redacted: 0 };
	// Iterate to a fixpoint: a mask normalizes to spaces, so masking one
	// span can bridge the halves of a multi-word term back into a match
	// ("shut fuck up" → "shut █ up" still matches "shut up"). Each pass
	// removes every current hit — a match always contains letters that
	// become spaces — so the loop terminates. The marker itself can never
	// match.
	let current = text;
	let redacted = 0;
	for (;;) {
		const { norm, map } = normalizeWithMap(current);
		ABUSE_RE.lastIndex = 0;
		/** @type {Array<[number, number]>} half-open spans in original offsets */
		const spans = [];
		for (let m = ABUSE_RE.exec(norm); m; m = ABUSE_RE.exec(norm)) {
			const start = map[m.index];
			const end = map[m.index + m[0].length - 1] + 1;
			spans.push([start, end]);
		}
		if (!spans.length) break;
		spans.sort((a, b) => a[0] - b[0]);
		const merged = [spans[0]];
		for (const span of spans.slice(1)) {
			const last = merged[merged.length - 1];
			if (span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
			else merged.push(span);
		}
		let out = '';
		let cursor = 0;
		for (const [start, end] of merged) {
			out += current.slice(cursor, start) + REDACTION;
			cursor = end;
		}
		out += current.slice(cursor);
		current = out.replace(new RegExp(`(${REDACTION})(\\s*${REDACTION})+`, 'g'), REDACTION);
		redacted += merged.length;
	}
	return { text: current, redacted };
}

/**
 * True when a redacted text has too little readable content to show —
 * fewer than two surviving words of 2+ alnum chars. At that point the
 * residue is more confusing than useful, so the whole comment conceals.
 *
 * @param {string} redactedText
 */
function tooThin(redactedText) {
	const words = redactedText
		.split(REDACTION)
		.join(' ')
		.split(/\s+/)
		.filter((w) => /[a-z0-9]/i.test(w) && w.replace(/[^a-z0-9]/gi, '').length >= 2);
	return words.length < 2;
}

/**
 * Produces the safe-to-render form of an evidence comment.
 *
 * @param {string} text - the raw comment text (untrusted).
 * @param {{ hasAbuse?: boolean }} [flags] - classifier signal: when true the
 *   comment conceals outright. A lexicon hit proves abuse was there, but a
 *   partial mask can leave unlisted wording readable — the lexicon can
 *   never prove it caught everything the classifier saw. The sanitized
 *   claim still carries the useful content into the finding summary.
 * @returns {{ text: string, concealed: boolean, redacted: number }} either
 *   masked text or the CONCEALED_MESSAGE placeholder.
 */
export function concealEvidence(text, { hasAbuse } = {}) {
	const { text: masked, redacted } = redactAbuse(text);
	// Masking that leaves under two real words is residue, not evidence —
	// conceal it too. A short-but-clean comment (nothing masked, no flag)
	// still renders.
	if (hasAbuse || (redacted > 0 && tooThin(masked))) {
		return { text: CONCEALED_MESSAGE, concealed: true, redacted };
	}
	return { text: masked, concealed: false, redacted };
}

/**
 * Sanitizes a model-written claim for storage. Claims are already
 * instructed to be clean; this is defense in depth. Returns '' when
 * nothing safe survives — the caller must drop that claim rather than
 * store the placeholder as a finding summary.
 *
 * @param {string} claim
 * @returns {string}
 */
export function sanitizeClaim(claim) {
	const { text: masked, redacted } = redactAbuse(claim);
	if (!redacted) return claim;
	return tooThin(masked) ? '' : masked;
}
