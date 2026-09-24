// The root layout's locale projection is the single gate every page reads
// (MOD-11): bilingual surfaces resolve the stored/browser preference;
// English-only surfaces get 'en' no matter what the cookie says — a pt-BR
// preference must not half-translate the app shell around English content.

import { expect, test } from 'vitest';

import { LOCALE_COOKIE } from '$lib/i18n/locale';
import { load } from './+layout.server';

function loadLocale(pathname: string, cookie?: string, acceptLanguage = 'en') {
	const result = load({
		cookies: { get: (name: string) => (name === LOCALE_COOKIE ? cookie : undefined) },
		request: { headers: { get: () => acceptLanguage } },
		url: new URL(`https://moderaty.example${pathname}`)
	} as never) as { locale: string };
	return result.locale;
}

test.each(['/login', '/account-deleted'])(
	'%s resolves the stored pt-BR preference',
	(pathname) => {
		expect(loadLocale(pathname, 'pt-BR')).toBe('pt-BR');
	}
);

test.each(['/', '/dashboard', '/channels/UC1', '/org', '/consent'])(
	'%s stays English even with a pt-BR cookie — the surface is not translated',
	(pathname) => {
		expect(loadLocale(pathname, 'pt-BR')).toBe('en');
	}
);

test('the browser language only resolves on bilingual paths', () => {
	expect(loadLocale('/login', undefined, 'pt-BR,pt;q=0.9')).toBe('pt-BR');
	expect(loadLocale('/dashboard', undefined, 'pt-BR,pt;q=0.9')).toBe('en');
});
