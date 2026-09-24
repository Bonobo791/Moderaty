// Labeled feedback corpus (MOD-87): hand-labeled EN + PT comments covering
// every digest category, abuse-wrapped variants, and `none`. Consumed by
// scripts/feedback-eval.mjs (live faithfulness + abuse-leak check) and by
// its deterministic leak gate in feedback-eval.test.mjs.
//
// Labels are deliberately unambiguous: a case whose expected category or
// hasAbuse could honestly go either way does not belong here — borderline
// wording would turn the eval into noise instead of a gate.
//
// The data lives in feedback-corpus.json, one row per case:
//   [text, lang, category, hasAbuse, note]
//   text:     the raw comment (eval input)
//   lang:     'en' | 'pt'
//   category: the digest bucket the classifier must return
//   hasAbuse: the abuse flag the classifier must return
//   note:     why the case exists (what it proves)

import { readFileSync } from 'node:fs';

import { FEEDBACK_CATEGORIES } from '../src/lib/server/feedbackPrompt.js';

const CATEGORY_SET = new Set(FEEDBACK_CATEGORIES);
const LANGS = new Set(['en', 'pt']);

const rows = JSON.parse(readFileSync(new URL('./feedback-corpus.json', import.meta.url), 'utf8'));

export const FEEDBACK_CORPUS = rows.map((row, i) => {
	const [text, lang, category, hasAbuse, note] = row;
	if (
		typeof text !== 'string' || !text ||
		!LANGS.has(lang) ||
		!CATEGORY_SET.has(category) ||
		typeof hasAbuse !== 'boolean' ||
		typeof note !== 'string' || !note
	) {
		throw new TypeError(`feedback-corpus.json row ${i} is malformed: ${JSON.stringify(row)}`);
	}
	return { text, lang, expected: { category, hasAbuse }, note };
});
