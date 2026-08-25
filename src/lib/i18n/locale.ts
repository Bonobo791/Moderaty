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
	// Derived from SUPPORTED_LOCALES: a hardcoded list silently rejects a newly
	// added locale at every boundary (cubic, PR #136).
	return (SUPPORTED_LOCALES as readonly string[]).includes(value ?? '');
}

function supportedLocaleFor(language: string): Locale | null {
	if (language === 'pt-br' || language === 'pt') return 'pt-BR';
	if (language === 'en' || language.startsWith('en-')) return 'en';
	return null;
}

function languageFromAcceptLanguage(header: string | null): Locale {
	if (!header) return 'en';
	const preferences = header
		.split(',')
		.map((part) => {
			const [language, ...parameters] = part.trim().split(';');
			const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
			const q = quality ? Number(quality.trim().slice(2)) : 1;
			return { language: language.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
		})
		.sort((left, right) => right.q - left.q);
	// A NON-POSITIVE quality excludes the language outright (RFC 7231 §5.3.1 —
	// q is 0–1, so a negative weight is never a low-priority candidate). The
	// exclusion binds the SUPPORTED LOCALE it names: a broader range ('pt;q=1')
	// must not smuggle back a locale an exact range excluded ('pt-BR;q=0')
	// (cubic/codex, PR #136 round 3).
	const excluded = new Set(preferences.filter((preference) => preference.q <= 0).map((preference) => supportedLocaleFor(preference.language)));
	// Most-specific match wins: a locale claimed by ANY non-wildcard range keeps
	// that range's quality, so the wildcard fallback only ever selects from the
	// locales no explicit range matched ('en;q=0.5,*;q=1' resolves en at 0.5
	// and lets the wildcard pick pt-BR).
	const claimed = new Set(
		preferences
			.filter((preference) => preference.q > 0 && preference.language !== '*')
			.map((preference) => supportedLocaleFor(preference.language))
			.filter((locale) => locale !== null && !excluded.has(locale))
	);
	for (const preference of preferences) {
		if (preference.q <= 0) continue;
		if (preference.language === '*') {
			const fallback = SUPPORTED_LOCALES.find((supported) => !excluded.has(supported) && !claimed.has(supported));
			if (fallback) return fallback;
			continue;
		}
		const locale = supportedLocaleFor(preference.language);
		if (locale && !excluded.has(locale)) return locale;
	}
	return 'en';
}

export function resolveLocale(input: { cookie?: string | null; acceptLanguage?: string | null }): Locale {
	if (isLocale(input.cookie)) return input.cookie;
	return languageFromAcceptLanguage(input.acceptLanguage ?? null);
}
