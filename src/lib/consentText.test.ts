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

import { describe, expect, it } from 'vitest';
import { segmentConsentText } from './consentText';
import { CONSENT_CHECKBOX_TEXT } from './server/legal';

describe('segmentConsentText', () => {
	it('splits the real consent sentence into exact text and link segments', () => {
		expect(segmentConsentText(CONSENT_CHECKBOX_TEXT)).toEqual([
			{ text: 'I am at least 18 years old and agree to the ' },
			{ text: 'Terms of Service', href: '/terms' },
			{ text: ', ' },
			{ text: 'Privacy Policy', href: '/privacy' },
			{ text: ', and ' },
			{ text: 'Data Processing Agreement', href: '/dpa' }
		]);
	});

	it('preserves every character of the input across the segments', () => {
		const text = 'Agree to the Terms of Service and Privacy Policy, plus the Data Processing Agreement today.';
		const segments = segmentConsentText(text);
		expect(segments.map((s) => s.text).join('')).toBe(text);
	});

	it('emits no empty leading text segment when the sentence starts with a document title', () => {
		expect(
			segmentConsentText('Terms of Service, Privacy Policy, Data Processing Agreement — read them')
		).toEqual([
			{ text: 'Terms of Service', href: '/terms' },
			{ text: ', ' },
			{ text: 'Privacy Policy', href: '/privacy' },
			{ text: ', ' },
			{ text: 'Data Processing Agreement', href: '/dpa' },
			{ text: ' — read them' }
		]);
	});

	it('keeps a trailing text segment after the last document title', () => {
		const segments = segmentConsentText(
			'Terms of Service / Privacy Policy / Data Processing Agreement apply.'
		);
		expect(segments.at(-1)).toEqual({ text: ' apply.' });
		expect(segments.at(-1)?.href).toBeUndefined();
	});

	it.each([
		{
			title: 'Terms of Service',
			text: 'I agree to the Privacy Policy and Data Processing Agreement'
		},
		{
			title: 'Privacy Policy',
			text: 'I agree to the Terms of Service and Data Processing Agreement'
		},
		{
			title: 'Data Processing Agreement',
			text: 'I agree to the Terms of Service and Privacy Policy'
		}
	])('fails loudly when the sentence is missing the $title link target', ({ title, text }) => {
		expect(() => segmentConsentText(text)).toThrowError(
			`consent sentence is missing the "${title}" link target`
		);
	});

	it('links a title that appears inside the trailing text', () => {
		// Only the FIRST occurrence of each title becomes a link; later mentions
		// stay plain text.
		const segments = segmentConsentText(
			'Terms of Service (the Terms of Service), Privacy Policy, Data Processing Agreement.'
		);
		expect(segments[0]).toEqual({ text: 'Terms of Service', href: '/terms' });
		expect(segments[1]).toEqual({ text: ' (the Terms of Service), ' });
	});
});
