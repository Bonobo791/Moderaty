import type { Handle } from '@sveltejs/kit';

import { isHttpError } from '@sveltejs/kit';

import { cookieSecure } from '$lib/server/oauthState';
import { LOCALE_COOKIE, isBilingualPath, resolveLocale } from '$lib/i18n/locale';
import { assertMigrationsCurrent } from '$lib/server/migrationGuard';
import { getSessionUser, SESSION_COOKIE } from '$lib/server/session';
import { isNoIndexRoute } from '$lib/server/siteIndex';

// Resolves the session cookie into locals.user for every request. When the
// session slid into its renewal window, the cookie is refreshed with the new
// expiry so active users never get logged out. A database failure here does
// NOT produce a bare 500 (maintainer decision): the request degrades to
// maintenance mode — locals.dbDown is set, the failure is logged loudly on
// the server, and the (app) layout/dashboard render a user-visible
// maintenance overlay. A valid user sees a loud maintenance state, never a
// silent downgrade to signed-out.
export const handle: Handle = async ({ event, resolve }) => {
	// The html lang must describe the actual content (MOD-11): the stored or
	// browser preference only applies on fully translated surfaces — anywhere
	// else the page is English and must say so.
	const locale = isBilingualPath(event.url.pathname)
		? resolveLocale({
				cookie: event.cookies.get(LOCALE_COOKIE),
				acceptLanguage: event.request?.headers?.get('accept-language')
			})
		: 'en';
	const resolveLocalized = () =>
		resolve(event, {
			transformPageChunk: ({ html, done }) =>
				done ? html.replace('<html lang="en">', `<html lang="${locale}">`) : html
		});
	// Internal surfaces carry X-Robots-Tag: noindex on every response — it
	// reaches crawlers even on the 302 an anonymous visitor gets from an
	// auth-gated page, where a <meta> tag could never exist. robots.txt
	// deliberately leaves these paths crawlable: a Disallow would hide the
	// header and let bare URLs index anyway.
	const respond = async (pending: Response | Promise<Response>) => {
		const response = await pending;
		if (isNoIndexRoute(event.route.id)) response.headers.set('X-Robots-Tag', 'noindex');
		return response;
	};
	// The health probe reports database health itself, and the public metadata
	// endpoints are independent of the application schema and session.
	// Bypassing the guard and session keeps all four available during outages.
	if (['/api/health', '/robots.txt', '/sitemap.xml', '/llms.txt'].includes(event.route.id ?? '')) {
		return respond(resolve(event));
	}
	// Deploy-ordering boundary (issue #81): if the database is behind the
	// deployed code's migration journal, every DB query would fail with
	// scattered "no such column" errors — fail the request here with one clear
	// 503 instead. The guard's deliberate HttpError passes through (a
	// deploy-ordering condition, NOT an outage — never degrades). A database
	// failure INSIDE the check is an outage: degrade to maintenance mode.
	// The site-wide coupling is intentional: public pages are prerendered and
	// served statically, while health and metadata endpoints bypass above.
	// Every request that reaches this point is DB-backed and would fail
	// downstream anyway.
	try {
		await assertMigrationsCurrent();
	} catch (e) {
		if (isHttpError(e)) throw e;
		console.error('migration guard query failed:', e);
		event.locals.dbDown = true;
		event.locals.user = null;
		return respond(resolveLocalized());
	}
	const token = event.cookies.get(SESSION_COOKIE);
	try {
		const resolution = await getSessionUser(token);
		event.locals.user = resolution?.user ?? null;
		if (resolution?.renewed && token) {
			event.cookies.set(SESSION_COOKIE, token, {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				secure: cookieSecure(),
				expires: new Date(resolution.expiresAt)
			});
		}
	} catch (e) {
		// A deliberate HttpError (e.g. the account-has-no-org integrity failure)
		// is NOT an outage: let it fail loudly instead of masking it as
		// maintenance and signing the user out.
		if (isHttpError(e)) throw e;
		console.error('session lookup failed:', e);
		event.locals.dbDown = true;
		event.locals.user = null;
	}
	return respond(resolveLocalized());
};
