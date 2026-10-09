import type { Handle, HandleServerError } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';

import { isHttpError, isRedirect, json } from '@sveltejs/kit';

import { cookieSecure } from '$lib/server/oauthState';
import { LOCALE_COOKIE, isBilingualPath, resolveLocale } from '$lib/i18n/locale';
import { assertMigrationsCurrent } from '$lib/server/migrationGuard';
import { getSessionUser, SESSION_COOKIE } from '$lib/server/session';
import { isNoIndexRoute, PUBLIC_BLOG_ROUTE_IDS } from '$lib/server/siteIndex';
import { emitOperationalEvent } from '$lib/server/operationalEvents';
import { escapeHtml } from '$lib/server/emailText';
import errorPage from './error.html?raw';

type Event = Parameters<Handle>[0]['event'];

function cacheResponse(response: Response, event: Event): Response {
	const etag = response.headers.get('etag');
	const clientHeader = event.request?.headers.get('if-none-match');
	// Match complete quoted tags: a comma can also occur inside an opaque tag.
	const tags = clientHeader?.match(/(?:W\/)?"[^"]*"/g) ?? [];
	const matches = clientHeader?.trim() === '*' || tags.some((tag) => tag.replace(/^W\//, '') === etag?.replace(/^W\//, ''));
	if (response.status !== 200 || etag === null || !matches) return response;
	const cacheHeaders = new Set(['etag', 'cache-control', 'content-location', 'date', 'expires', 'vary', 'set-cookie']);
	const headers = new Headers(Array.from(response.headers).filter(([key]) => cacheHeaders.has(key)));
	// Preserve separate Set-Cookie fields rather than a comma-joined value.
	headers.delete('set-cookie');
	for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie);
	return new Response(null, { status: 304, headers });
}

function dataRedirectResponse(response: Response, event: Event): Response {
	if (!event.isDataRequest || response.status < 300 || response.status > 308) return response;
	const location = response.headers.get('location');
	if (!location) return response;
	const headers = new Headers(response.headers);
	for (const key of ['location', 'content-type', 'content-length', 'content-encoding', 'etag']) headers.delete(key);
	headers.set('cache-control', 'private, no-store');
	return json({ type: 'redirect', location }, { headers });
}

function correlate(response: Response, event: Event): Response {
	// These conversions otherwise happen after handle() and discard custom
	// headers. Preserve the same cache/redirect outcome before adding ours.
	response = dataRedirectResponse(cacheResponse(response, event), event);
	const headers = new Headers(response.headers);
	headers.set('X-Request-ID', event.locals.requestId);
	if (isNoIndexRoute(event.route.id)) headers.set('X-Robots-Tag', 'noindex');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function wantsJson(event: Event): boolean {
	if (event.isDataRequest) return true;
	const ranges = (event.request?.headers.get('accept') ?? 'text/html').split(',').map((part, order) => {
		const [mediaValue, ...parameters] = part.trim().toLowerCase().split(';');
		const media = mediaValue.trim();
		const qualityParameter = parameters.find((value) => value.trim().startsWith('q='));
		const quality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
		let specificity = 2;
		if (media === '*/*') specificity = 0;
		else if (media.endsWith('/*')) specificity = 1;
		return { media, quality, order, specificity };
	}).filter(({ quality }) => Number.isFinite(quality) && quality >= 0 && quality <= 1)
		.toSorted((a, b) => b.specificity - a.specificity || b.quality - a.quality || a.order - b.order);
	// A representation's most specific range sets its quality, including q=0.
	// Only then compare the acceptable representations with each other.
	const candidates = ['application/json', 'text/html'].flatMap((representation) => {
		const range = ranges.find(({ media }) => media === representation || media === representation.split('/')[0] + '/*' || media === '*/*');
		return range && range.quality > 0 ? [{ ...range, representation }] : [];
	}).toSorted((a, b) => b.quality - a.quality || b.specificity - a.specificity || a.order - b.order);
	return candidates[0]?.representation === 'application/json';
}

// Hook-thrown errors are rendered outside resolve() by SvelteKit, which drops
// hook headers. Return controlled responses here so correlation survives too.
export const handle: Handle = async (input) => {
	const { event } = input;
	event.locals.requestId = randomUUID();
	try {
		return correlate(await handleRequest(input), event);
	} catch (error_) {
		if (isRedirect(error_)) {
			return correlate(new Response(null, { status: error_.status, headers: { location: error_.location } }), event);
		}
		const status = isHttpError(error_) ? error_.status : 500;
		const body = isHttpError(error_) ? error_.body : await handleError({ error: error_, event, status, message: 'Internal Error' }) ?? { message: 'Internal Error' };
		if (wantsJson(event)) {
			return correlate(json(body, { status }), event);
		}
		const locale = isBilingualPath(event.url.pathname)
			? resolveLocale({ cookie: event.cookies.get(LOCALE_COOKIE), acceptLanguage: event.request?.headers.get('accept-language') }) : 'en';
		const htmlLang = locale === 'pt-BR' ? '<html lang="pt-BR">' : '<html lang="en">';
		const html = errorPage.replace('<html lang="en">', htmlLang)
			.split('%sveltekit.status%').join(String(status))
			.split('%sveltekit.error.message%').join(escapeHtml(body.message ?? 'Internal Error'));
		return correlate(new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }), event);
	}
};

// Resolves the session cookie into locals.user for every request. When the
// session slid into its renewal window, the cookie is refreshed with the new
// expiry so active users never get logged out. A database failure here does
// NOT produce a bare 500 (maintainer decision): the request degrades to
// maintenance mode — locals.dbDown is set, the failure is logged loudly on
// the server, and the (app) layout/dashboard render a user-visible
// maintenance overlay. A valid user sees a loud maintenance state, never a
// silent downgrade to signed-out.
const handleRequest: Handle = async ({ event, resolve }) => {
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
	if (PUBLIC_BLOG_ROUTE_IDS.includes(event.route.id ?? '')) {
		return resolveLocalized();
	}
	// The health probe reports database health itself; public metadata and
	// analytics configuration are independent of the schema and session.
	// Bypassing the guard keeps them available during database outages.
	if (['/api/health', '/api/analytics', '/robots.txt', '/sitemap.xml', '/llms.txt'].includes(event.route.id ?? '')) {
		return resolve(event);
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
		emitOperationalEvent({ type: 'migration_check_failed', severity: 'error', category: 'database', route: event.route.id, requestId: event.locals.requestId });
		if (isHttpError(e)) throw e;
		event.locals.dbDown = true;
		event.locals.user = null;
		return resolveLocalized();
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
		// Correlate controlled failures too; never serialize their error body.
		emitOperationalEvent({ type: 'session_lookup_failed', severity: 'error', category: 'database', route: event.route.id, requestId: event.locals.requestId });
		// A deliberate HttpError (e.g. the account-has-no-org integrity failure)
		// is NOT an outage: let it fail loudly instead of masking it as
		// maintenance and signing the user out.
		if (isHttpError(e)) throw e;
		event.locals.dbDown = true;
		event.locals.user = null;
	}
	return resolveLocalized();
};

/**
 * SvelteKit's default handleError prints every unexpected error as a
 * `[500] METHOD path` + stack — including clients that closed the socket
 * mid-request (adapter-node aborts event.request.signal on disconnect,
 * which surfaces here as `Error: aborted` / ECONNRESET). A gone client is
 * not a server defect, and fake 500s bury real ones in ops logs — demote
 * the abort-shaped subset to a warn line that still names the request.
 * The request-signal check keeps OUR in-flight aborts (fetch timeouts
 * inside actions) on the error path: only a dead connection downgrades.
 * Redirects and deliberate HttpErrors never reach this hook.
 */
function isAbortLike(error: unknown): boolean {
	try {
		return (
			error !== null &&
			typeof error === 'object' &&
			((error as Error).message === 'aborted' ||
				(error as Error).name === 'AbortError' ||
				(error as { code?: string }).code === 'ECONNRESET')
		);
	} catch {
		// Provider accessors are untrusted too. Keep the generic error category.
		return false;
	}
}

export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (event.request.signal.aborted && isAbortLike(error)) {
		emitOperationalEvent({ type: 'request_disconnected', severity: 'warn', category: 'client_disconnect', route: event.route.id, requestId: event.locals?.requestId });
	} else if (status === 404) {
		// Framework 404s (unmatched routes, missing data requests) land here as
		// SvelteKitError — scanner noise, not a defect. Keep at warn level.
		emitOperationalEvent({ type: 'request_not_found', severity: 'warn', category: 'not_found', route: event.route.id, requestId: event.locals?.requestId });
	} else {
		emitOperationalEvent({ type: 'unexpected_server_error', severity: 'error', category: 'unexpected', route: event.route.id, requestId: event.locals?.requestId });
	}
	return { message };
};
