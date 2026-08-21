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

import { resolveLocale } from './locale';
import { t } from './messages';

describe('locale resolution', () => {
	test('a valid cookie wins over the browser preference', () => {
		expect(resolveLocale({ cookie: 'en', acceptLanguage: 'pt-BR,pt;q=0.9' })).toBe('en');
	});

	test('Portuguese browser preferences select Brazilian Portuguese', () => {
		expect(resolveLocale({ acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.8' })).toBe('pt-BR');
	});

	test('invalid or unsupported preferences fail closed to English', () => {
		expect(resolveLocale({ cookie: 'fr', acceptLanguage: 'de-DE' })).toBe('en');
	});
});

describe('message catalog', () => {
	test('every shell message has both translations', () => {
		const keys = ['languageLabel', 'english', 'portuguese', 'apply', 'app', 'dashboard', 'usage', 'team', 'help', 'switchTeam', 'signOut', 'maintenance', 'moderationPaused', 'databaseUnavailable', 'signInTitle', 'signInDescription', 'signInGoogle', 'finishAccount', 'updatedTerms', 'finishAccountPrompt', 'legalChanged', 'createAccount', 'acceptContinue', 'marketingText'] as const;
		for (const key of keys) {
			expect(t('en', key)).not.toBe('');
			expect(t('pt-BR', key)).not.toBe('');
		}
	});
});
