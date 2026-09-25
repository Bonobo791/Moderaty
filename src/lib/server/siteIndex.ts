import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

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
	'/dpa'
] as const;

// Paths crawlers should not fetch. /contact/verify is deliberately absent:
// Disallow would hide its noindex meta, letting the bare URL index anyway.
const DISALLOWED_PATHS = [
	'/api/',
	'/account',
	'/account-deleted',
	'/channels/',
	'/connect-channel',
	'/consent',
	'/dashboard',
	'/help',
	'/invite/',
	'/logout',
	'/org',
	'/usage'
] as const;

// APP_URL is the canonical public origin (the Bunny domain in production).
// Absolute sitemap/robots URLs come from it — not the request — so a
// misconfigured deployment fails loudly instead of serving internal hosts.
function appUrl(): string {
	if (!env.APP_URL) throw error(500, 'APP_URL is not configured');
	return env.APP_URL;
}

export function robotsTxt(): string {
	return [
		'User-agent: *',
		...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
		'',
		`Sitemap: ${new URL('/sitemap.xml', appUrl()).toString()}`,
		''
	].join('\n');
}

export function sitemapXml(): string {
	const base = appUrl();
	const urls = PUBLIC_PAGES.map(
		(path) => `\t<url><loc>${new URL(path, base).toString()}</loc></url>`
	).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function llmsTxt(): string {
	const base = appUrl();
	const link = (path: string) => new URL(path, base).toString();
	return [
		'# Moderaty',
		'',
		'> Comment protection for YouTube creators. Moderaty reads every comment,',
		'> enforces the channel owner\'s rules instantly, scores the rest with AI',
		'> across 13 toxicity categories, and holds the borderline for one-click',
		'> review.',
		'',
		'## Product',
		'',
		`- [Home](${link('/')}) — feature overview, how it works, and FAQ`,
		`- [Pricing](${link('/pricing')}) — plans and usage-based billing`,
		`- [Contact](${link('/contact')}) — support and inquiries`,
		`- [Sign in](${link('/login')}) — Google sign-in`,
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
