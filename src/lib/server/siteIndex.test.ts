import { beforeEach, expect, test, vi } from 'vitest';
import { llmsTxt, PUBLIC_PAGES, robotsTxt, sitemapXml } from './siteIndex';
import { GET as robotsGet } from '../../routes/robots.txt/+server';
import { GET as sitemapGet } from '../../routes/sitemap.xml/+server';
import { GET as llmsGet } from '../../routes/llms.txt/+server';

const mocks = vi.hoisted(() => ({
	env: { APP_URL: 'https://moderaty.example' } as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

beforeEach(() => {
	mocks.env.APP_URL = 'https://moderaty.example';
});

const PRIVATE_PATHS = [
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
];

test('the sitemap lists exactly the public pages as absolute APP_URL URLs', () => {
	const xml = sitemapXml();

	expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
	expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
	expect(xml.match(/<loc>/g)).toHaveLength(PUBLIC_PAGES.length);
	for (const path of PUBLIC_PAGES) {
		expect(xml).toContain(`<loc>https://moderaty.example${path === '/' ? '/' : path}</loc>`);
	}
});

test.each(PRIVATE_PATHS)('the sitemap never publishes %s', (path) => {
	expect(sitemapXml()).not.toContain(`<loc>https://moderaty.example${path}`);
});

test('robots.txt allows crawling, bars the private surface, and points at the sitemap', () => {
	const body = robotsTxt();

	expect(body.startsWith('User-agent: *\n')).toBe(true);
	for (const path of PRIVATE_PATHS) {
		expect(body).toContain(`Disallow: ${path}`);
	}
	expect(body.trimEnd().endsWith('Sitemap: https://moderaty.example/sitemap.xml')).toBe(true);
});

test('robots.txt does NOT disallow /contact/verify — a Disallow would hide its noindex meta', () => {
	expect(robotsTxt()).not.toContain('verify');
});

test('llms.txt is a markdown index whose links all resolve under APP_URL', () => {
	const body = llmsTxt();

	expect(body.startsWith('# Moderaty\n')).toBe(true);
	expect(body).toContain('> Comment protection for YouTube creators');
	expect(body).toContain('## Product');
	expect(body).toContain('## Legal');
	for (const path of ['/pricing', '/contact', '/login', '/terms', '/privacy', '/dpa']) {
		expect(body).toContain(`](https://moderaty.example${path})`);
	}
	// Every markdown link target lives on this instance — no third-party host.
	for (const [, href] of body.matchAll(/\]\(([^)]+)\)/g)) {
		expect(href.startsWith('https://moderaty.example/')).toBe(true);
	}
});

test.each([
	['robotsTxt', robotsTxt],
	['sitemapXml', sitemapXml],
	['llmsTxt', llmsTxt]
])('%s fails loudly with 500 when APP_URL is not configured', (_name, build) => {
	mocks.env.APP_URL = undefined;

	let thrown: unknown;
	try {
		build();
	} catch (e) {
		thrown = e;
	}
	expect(thrown).toMatchObject({ status: 500, body: { message: 'APP_URL is not configured' } });
});

test('the sitemap endpoint answers 200 application/xml with the built body', async () => {
	const res = await sitemapGet({} as never);

	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
	expect(await res.text()).toBe(sitemapXml());
});

test('the robots endpoint answers 200 text/plain with the built body', async () => {
	const res = await robotsGet({} as never);

	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
	expect(await res.text()).toBe(robotsTxt());
});

test('the llms endpoint answers 200 text/plain with the built body', async () => {
	const res = await llmsGet({} as never);

	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
	expect(await res.text()).toBe(llmsTxt());
});
