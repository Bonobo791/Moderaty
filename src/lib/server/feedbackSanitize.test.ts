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
	CONCEALED_MESSAGE,
	REDACTION,
	concealEvidence,
	redactAbuse,
	sanitizeClaim
} from './feedbackSanitize';

describe('redactAbuse', () => {
	test('passes clean text through unchanged', () => {
		expect(redactAbuse('the audio at 3:00 is blown out')).toEqual({
			text: 'the audio at 3:00 is blown out',
			redacted: 0
		});
	});

	test('masks a profane span with the redaction marker', () => {
		const { text, redacted } = redactAbuse('you idiot, check the torque spec');
		expect(redacted).toBe(1);
		expect(text).toBe(`you ${REDACTION}, check the torque spec`);
	});

	test('redaction preserves original casing and punctuation around the mask', () => {
		const { text } = redactAbuse('This is SHITTY work, honestly.');
		expect(text).toBe(`This is ${REDACTION} work, honestly.`);
	});

	test('folds leetspeak so obfuscated abuse still masks', () => {
		expect(redactAbuse('what a 5h1t take').text).toBe(`what a ${REDACTION} take`);
		expect(redactAbuse('total b*llsh1t').redacted).toBe(1);
	});

	test('folds masked spellings like f*ck', () => {
		expect(redactAbuse('f*ck this editor').text).toBe(`${REDACTION} this editor`);
	});

	test('matches accented Portuguese terms without diacritics', () => {
		expect(redactAbuse('esse vídeo é uma bosta').text).toBe(`esse vídeo é uma ${REDACTION}`);
		expect(redactAbuse('vai se foder cara').text).toBe(`${REDACTION} cara`);
		expect(redactAbuse('cuzão demais').redacted).toBe(1);
	});

	test('never matches substrings inside longer words', () => {
		for (const clean of [
			'the class assignment',
			'computar isso é fácil',
			'Scunthorpe United',
			'hello there',
			'analyzing the data',
			'my therapist said'
		]) {
			expect(redactAbuse(clean)).toEqual({ text: clean, redacted: 0 });
		}
	});

	test('collapses a run of adjacent masked spans into one marker', () => {
		const { text } = redactAbuse('this shit fuck sucks hard');
		expect(text).toBe(`this ${REDACTION} sucks hard`);
	});

	test('matches multi-word phrases across punctuation and extra spaces', () => {
		expect(redactAbuse('kill   yourself already').text).toBe(`${REDACTION} already`);
		expect(redactAbuse('go.die').redacted).toBe(1);
	});

	test('a mask must not bridge a multi-word insult back into view', () => {
		// 'shut fuck up': masking 'fuck' leaves 'shut █ up', which still reads
		// as 'shut up' — the pass re-scans until nothing matches, so the whole
		// phrase conceals (cubic).
		expect(redactAbuse('shut fuck up').text).toBe(REDACTION);
		expect(redactAbuse(redactAbuse('shut fuck up').text).redacted).toBe(0);
	});

	test('does not over-match innocent Portuguese words after diacritic folding', () => {
		// 'pos' folds pôs/pós onto it — common words like 'pós-graduação'
		// must never mask (cubic).
		for (const clean of ['minha pós-graduação começa segunda', 'ele pôs a mesa', 'pós-jogo']) {
			expect(redactAbuse(clean)).toEqual({ text: clean, redacted: 0 });
		}
	});

	test('empty and whitespace input returns empty unchanged', () => {
		expect(redactAbuse('')).toEqual({ text: '', redacted: 0 });
	});
});

describe('concealEvidence', () => {
	test('clean comments render their redacted text unconcealed', () => {
		expect(concealEvidence('the audio at 3:00 is blown out', { hasAbuse: false })).toEqual({
			text: 'the audio at 3:00 is blown out',
			concealed: false,
			redacted: 0
		});
	});

	test('a flagged comment conceals even when the lexicon masked part of it', () => {
		// The lexicon can never prove it masked ALL the abuse — 'idiot' is
		// masked here but an unlisted second insult would render verbatim.
		// A hasAbuse flag therefore conceals the whole excerpt; the sanitized
		// claim still carries the feedback in the finding summary
		// (cubic+codex+coderabbit).
		const out = concealEvidence('you idiot, the audio at 3:00 is blown out', { hasAbuse: true });
		expect(out).toMatchObject({ text: CONCEALED_MESSAGE, concealed: true });
	});

	test('hasAbuse with no lexicon hit conceals the whole comment', () => {
		// The model saw abuse the lexicon cannot pinpoint — hide everything
		// rather than gamble on which word was the insult.
		expect(concealEvidence('absolute noodle-tier effort buddy', { hasAbuse: true }).text).toBe(
			CONCEALED_MESSAGE
		);
	});

	test('a comment that is mostly mask conceals even without the flag', () => {
		expect(concealEvidence('fuck you idiot', { hasAbuse: false }).text).toBe(CONCEALED_MESSAGE);
	});

	test('pure-abuse residue like "you" left after masking conceals', () => {
		expect(concealEvidence('you bitch', {}).text).toBe(CONCEALED_MESSAGE);
	});

	test('hasAbuse defaults to false when flags are omitted', () => {
		const out = concealEvidence('the pacing dragged in the middle section');
		expect(out).toEqual({
			text: 'the pacing dragged in the middle section',
			concealed: false,
			redacted: 0
		});
	});
});

describe('sanitizeClaim', () => {
	test('returns clean claims untouched', () => {
		expect(sanitizeClaim('the torque spec is 25 ft-lb')).toBe('the torque spec is 25 ft-lb');
	});

	test('returns empty string when the claim is nothing but abuse', () => {
		expect(sanitizeClaim('fuck this idiot')).toBe('');
	});

	test('redacts a stray profane word inside an otherwise usable claim', () => {
		expect(sanitizeClaim('audio mix sounds like shit on mobile speakers')).toBe(
			`audio mix sounds like ${REDACTION} on mobile speakers`
		);
	});
});
