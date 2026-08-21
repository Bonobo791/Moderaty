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

export const LOCALE_COOKIE = 'moderaty_locale';
export const SUPPORTED_LOCALES = ['en', 'pt-BR'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export function isLocale(value: string | null | undefined): value is Locale {
	return value === 'en' || value === 'pt-BR';
}

function languageFromAcceptLanguage(header: string | null): Locale {
	if (!header) return 'en';
	const preferences = header
		.split(',')
		.map((part) => {
			const [language, ...parameters] = part.trim().split(';');
			const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
			const q = quality ? Number(quality.trim().slice(2)) : 1;
			return { language: language.toLowerCase(), q: Number.isFinite(q) ? q : 0 };
		})
		.filter((preference) => preference.q > 0)
		.sort((left, right) => right.q - left.q);
	for (const preference of preferences) {
		if (preference.language === 'pt-br' || preference.language === 'pt') return 'pt-BR';
		if (preference.language === 'en' || preference.language.startsWith('en-')) return 'en';
	}
	return 'en';
}

export function resolveLocale(input: { cookie?: string | null; acceptLanguage?: string | null }): Locale {
	if (isLocale(input.cookie)) return input.cookie;
	return languageFromAcceptLanguage(input.acceptLanguage ?? null);
}
