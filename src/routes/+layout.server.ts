import type { LayoutServerLoad } from './$types';

import { LOCALE_COOKIE, isBilingualPath, resolveLocale } from '$lib/i18n/locale';

export const load: LayoutServerLoad = ({ cookies, request, url }) => ({
	// The single locale gate every page reads (MOD-11): bilingual surfaces
	// resolve the stored/browser preference; English-only surfaces get 'en'
	// so a pt-BR preference can never half-translate untranslated content.
	locale: isBilingualPath(url.pathname)
		? resolveLocale({
				cookie: cookies.get(LOCALE_COOKIE),
				acceptLanguage: request.headers.get('accept-language')
			})
		: 'en'
});
