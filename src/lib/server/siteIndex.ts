import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { HATE_COMMENTS } from '$lib/blogs/hate-comments';

// The crawlable surface: marketing, legal, and the two public utility
// pages. Everything else — the (app) console, OAuth/consent/invite/verify
// flow pages, and /api — is authenticated or single-use and stays out of
// the sitemap on purpose.
export const PUBLIC_PAGES = [
	'/',
	'/pricing',
	'/contact',
	'/login',
	'/privacy',
	'/terms',
	'/dpa',
	'/blogs/',
	HATE_COMMENTS.path
] as const;

// Runtime-rendered editorial pages need the configured origin, not a session or DB.
export const PUBLIC_BLOG_ROUTE_IDS = ['/blogs', HATE_COMMENTS.path.slice(0, -1)];

// Route ids that must never appear in a search index: the authenticated
// (app) console, single-use flow pages, and every API endpoint. Keyed on
// route.id (not the URL) so trailing-slash variants and param routes match.
// The header these drive (X-Robots-Tag, set in hooks.server.ts) also marks
// the 302 an anonymous crawler gets from an auth-gated page, where a <meta>
// tag could never exist.
const NOINDEX_ROUTES = ['/consent', '/connect-channel', '/logout', '/account-deleted', '/contact/verify'];
const NOINDEX_PREFIXES = ['/(app)/', '/api/', '/invite/'];

export function isNoIndexRoute(routeId: string | null | undefined): boolean {
	if (!routeId) return false;
	return NOINDEX_ROUTES.includes(routeId) || NOINDEX_PREFIXES.some((prefix) => routeId.startsWith(prefix));
}

// APP_URL is the canonical public origin (the Bunny domain in production).
// Absolute sitemap/robots URLs come from it — not the request — so a
// misconfigured deployment fails loudly instead of serving internal hosts.
export function siteOrigin(): string {
	if (!env.APP_URL) throw error(500, 'APP_URL is not configured');
	const parsed = URL.parse(env.APP_URL);
	if (
		!parsed ||
		(parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== '/' ||
		parsed.search ||
		parsed.hash ||
		env.APP_URL.includes('?') ||
		env.APP_URL.includes('#')
	) {
		throw error(500, 'APP_URL is not configured as a valid absolute http(s) origin');
	}
	return parsed.origin;
}

export function robotsTxt(): string {
	return [
		'User-agent: *',
		// Only /api stays barred — it is endpoints, not pages. Internal pages
		// stay crawlable so their X-Robots-Tag: noindex header (see
		// isNoIndexRoute / hooks.server.ts) is actually seen: a Disallow would
		// hide the tag, letting bare URLs index anyway.
		'Disallow: /api/',
		'',
		`Sitemap: ${new URL('/sitemap.xml', siteOrigin()).toString()}`,
		''
	].join('\n');
}

export function sitemapXml(): string {
	const base = siteOrigin();
	const urls = PUBLIC_PAGES.map((path) =>
		['\t<url><loc>', new URL(path, base).toString(), '</loc></url>'].join('')
	).join('\n');
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		urls,
		'</urlset>',
		''
	].join('\n');
}

export function llmsTxt(): string {
	const base = siteOrigin();
	const link = (path: string) => new URL(path, base).toString();
	return [
		'# Moderaty',
		'',
		'> Comment protection for YouTube creators. Moderaty reads every comment,',
		'> enforces the channel owner\'s rules instantly, scores the rest with AI',
		'> across 13 toxicity categories, and holds the borderline for one-click',
		'> review. An opt-in feedback digest groups the comments worth hearing',
		'> into the themes viewers keep raising.',
		'',
		'## Product',
		'',
		`- [Home](${link('/')}) — feature overview, how it works, and FAQ`,
		`- [Pricing](${link('/pricing')}) — plans and usage-based billing`,
		`- [Contact](${link('/contact')}) — support and inquiries`,
		`- [Sign in](${link('/login')}) — Google sign-in`,
		`- [Blogs](${link('/blogs/')}) — YouTube comment moderation advice`,
		`- [${HATE_COMMENTS.title}](${link(HATE_COMMENTS.path)}) — choosing a response to hurtful comments`,
		'',
		'## Legal',
		'',
		`- [Terms of Service](${link('/terms')})`,
		`- [Privacy Policy](${link('/privacy')})`,
		`- [Data Processing Agreement](${link('/dpa')})`,
		'',
		'## Optional',
		'',
		`- [Sitemap](${link('/sitemap.xml')})`,
		`- [robots.txt](${link('/robots.txt')})`,
		''
	].join('\n');
}
