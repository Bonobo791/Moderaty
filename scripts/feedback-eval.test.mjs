import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import { FEEDBACK_CATEGORIES } from '../src/lib/server/feedbackPrompt.js';
import { concealEvidence, redactAbuse } from '../src/lib/server/feedbackSanitize.js';
import { FEEDBACK_CORPUS } from './feedback-corpus.mjs';
import { abuseLeaks, parseVerdict } from './feedback-eval.mjs';

// ---- corpus sanity (MOD-87) ----

test('the corpus covers every category in both languages, clean and abusive', () => {
	expect(FEEDBACK_CORPUS.length).toBeGreaterThanOrEqual(30);
	const cells = new Set(FEEDBACK_CORPUS.map((c) => `${c.lang}:${c.expected.category}:${c.expected.hasAbuse}`));
	for (const lang of ['en', 'pt']) {
		for (const category of ['question', 'criticism', 'correction', 'request']) {
			expect(cells.has(`${lang}:${category}:false`), `${lang} ${category} clean`).toBe(true);
		}
		// Every language needs abusive cases (the concealment path) and
		// clean none cases (the drop path).
		expect(cells.has(`${lang}:none:false`), `${lang} none clean`).toBe(true);
		expect(cells.has(`${lang}:none:true`), `${lang} none abusive`).toBe(true);
		expect([...cells].some((c) => c.startsWith(`${lang}:`) && c.endsWith(':true')), `${lang} abuse coverage`).toBe(true);
	}
});

test('every corpus case is well-formed — valid category, language, note, unique text', () => {
	const seen = new Set();
	for (const c of FEEDBACK_CORPUS) {
		expect(typeof c.text).toBe('string');
		expect(c.text.length).toBeGreaterThan(0);
		expect(['en', 'pt']).toContain(c.lang);
		expect(FEEDBACK_CATEGORIES).toContain(c.expected.category);
		expect(typeof c.expected.hasAbuse).toBe('boolean');
		expect(typeof c.note).toBe('string');
		expect(seen.has(c.text)).toBe(false);
		seen.add(c.text);
	}
});

// ---- deterministic abuse-leak gate (MOD-93, API-free) ----

test('the sanitizer leaks nothing for any corpus case, given its labeled flag', () => {
	// The deterministic half of the eval: whatever the classifier says at
	// runtime, the corpus label here stands in for hasAbuse — the concealed
	// output must never contain a lexicon term. This is the always-on gate;
	// the live eval checks the same property on real classifications.
	for (const c of FEEDBACK_CORPUS) {
		const out = concealEvidence(c.text, { hasAbuse: c.expected.hasAbuse });
		expect(redactAbuse(out.text).redacted, `leak in "${c.text}" → "${out.text}"`).toBe(0);
	}
});

// ---- parseVerdict (mirrors feedback.ts validation) ----

test('parseVerdict accepts a well-formed verdict and trims the claim', () => {
	const v = parseVerdict(JSON.stringify({ category: 'question', hasAbuse: false, claim: '  when is the next video  ' }));
	expect(v).toEqual({ category: 'question', hasAbuse: false, claim: 'when is the next video' });
});

test.each([
	['not json', 'not json at all'],
	['missing category', JSON.stringify({ hasAbuse: false, claim: '' })],
	['bad category', JSON.stringify({ category: 'hate', hasAbuse: false, claim: 'x' })],
	['non-bool hasAbuse', JSON.stringify({ category: 'none', hasAbuse: 'yes', claim: '' })],
	['non-string claim', JSON.stringify({ category: 'none', hasAbuse: false, claim: 4 })],
	['overlong claim', JSON.stringify({ category: 'question', hasAbuse: false, claim: 'x'.repeat(81) })],
	['category with empty claim', JSON.stringify({ category: 'question', hasAbuse: false, claim: '  ' })]
])('parseVerdict rejects %s loudly', (_label, content) => {
	expect(() => parseVerdict(content)).toThrow(TypeError);
});

test('parseVerdict normalizes a stray claim on a none verdict to empty', () => {
	const v = parseVerdict(JSON.stringify({ category: 'none', hasAbuse: false, claim: 'should be dropped' }));
	expect(v.claim).toBe('');
});

// ---- abuseLeaks helper ----

test('abuseLeaks flags an abuse term the model left in the claim', () => {
	const leaks = abuseLeaks('clean comment', { category: 'question', hasAbuse: false, claim: 'what mic, idiot' });
	expect(leaks.some((l) => l.includes('claim contains an abuse term'))).toBe(true);
});

test('abuseLeaks accepts an abusive-text verdict whose mask leaves the claim readable', () => {
	// The lexicon masks "pathetic" and the surviving excerpt is clean — an
	// abusive comment with an honest flag produces zero leaks.
	const leaks = abuseLeaks('you are pathetic and your audio is blown', {
		category: 'criticism',
		hasAbuse: true,
		claim: 'the audio is blown'
	});
	expect(leaks).toEqual([]);
});

test('abuseLeaks flags a claim that sanitizes to nothing', () => {
	const leaks = abuseLeaks('whatever', {
		category: 'question',
		hasAbuse: false,
		claim: 'idiot' // single lexicon term — sanitizeClaim returns ''
	});
	expect(leaks.some((l) => l.includes('sanitizes to nothing'))).toBe(true);
});

test('abuseLeaks accepts a fully-clean verdict', () => {
	const leaks = abuseLeaks('when is the next video?', {
		category: 'question',
		hasAbuse: false,
		claim: 'when is the next video'
	});
	expect(leaks).toEqual([]);
});

// ---- shared-module contract (same guard as tone-eval's) ----

test('the feedback rubric lives in one shared module imported by both feedback.ts and the eval script', () => {
	const feedbackSource = readFileSync(new URL('../src/lib/server/feedback.ts', import.meta.url), 'utf8');
	expect(feedbackSource).toMatch(/import\s+\{[^}]*\b(?:FEEDBACK_PROMPT|buildFeedbackPrompt|FEEDBACK_CATEGORIES)\b[^}]*\}\s+from '\$lib\/server\/feedbackPrompt'/);
	expect(feedbackSource).not.toContain('const FEEDBACK_PROMPT');
	const scriptSource = readFileSync(new URL('./feedback-eval.mjs', import.meta.url), 'utf8');
	expect(scriptSource).toMatch(/from '\.\.\/src\/lib\/server\/feedbackPrompt\.js'/);
	expect(scriptSource).not.toContain('const FEEDBACK_PROMPT = `');
});
