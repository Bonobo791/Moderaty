// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Advanced Digital Marketing LTDA
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

import { isLocale, resolveLocale, SUPPORTED_LOCALES } from './locale';
import { t } from './messages';

describe('locale resolution', () => {
	test('isLocale accepts exactly the supported locales, derived from SUPPORTED_LOCALES', () => {
		// The runtime check must be derived from SUPPORTED_LOCALES — a hardcoded
		// list silently rejects a newly added locale at every boundary (cubic).
		for (const locale of SUPPORTED_LOCALES) {
			expect(isLocale(locale)).toBe(true);
		}
		expect(isLocale('fr')).toBe(false);
		expect(isLocale('EN')).toBe(false);
		expect(isLocale('pt')).toBe(false);
		expect(isLocale('')).toBe(false);
		expect(isLocale(null)).toBe(false);
		expect(isLocale(undefined)).toBe(false);
	});
	test('a valid cookie wins over the browser preference', () => {
		expect(resolveLocale({ cookie: 'en', acceptLanguage: 'pt-BR,pt;q=0.9' })).toBe('en');
	});

	test('Portuguese browser preferences select Brazilian Portuguese', () => {
		expect(resolveLocale({ acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.8' })).toBe('pt-BR');
	});

	test('whitespace around the language tag still matches', () => {
		expect(resolveLocale({ acceptLanguage: 'pt-BR ; q=0.9' })).toBe('pt-BR');
		expect(resolveLocale({ acceptLanguage: ' en ; q=0.9' })).toBe('en');
	});

	test('an explicit q=0 excludes the language even when a wildcard is present', () => {
		// 'en;q=0' means "anything but English" — the wildcard must fall
		// through to the other supported locale, never return the excluded one.
		expect(resolveLocale({ acceptLanguage: 'en;q=0,*;q=1' })).toBe('pt-BR');
		expect(resolveLocale({ acceptLanguage: 'pt;q=0,*;q=0.5' })).toBe('en');
	});

	test('invalid or unsupported preferences fail closed to English', () => {
		expect(resolveLocale({ cookie: 'fr', acceptLanguage: 'de-DE' })).toBe('en');
	});
});

describe('message catalog', () => {
	test('every shell message has both translations', () => {
		const keys = ['languageLabel', 'english', 'portuguese', 'apply', 'app', 'dashboard', 'usage', 'team', 'help', 'switchTeam', 'signOut', 'maintenance', 'moderationPaused', 'databaseUnavailable', 'signInTitle', 'signInDescription', 'signInGoogle', 'finishAccount', 'almostThere', 'updatedTerms', 'finishAccountPrompt', 'legalChanged', 'createAccount', 'acceptContinue', 'marketingText'] as const;
		for (const key of keys) {
			expect(t('en', key)).not.toBe('');
			expect(t('pt-BR', key)).not.toBe('');
		}
	});
});
