import { render } from 'svelte/server';
import { beforeEach, expect, test, vi } from 'vitest';
import { sitemapXml } from '$lib/server/siteIndex';
import { load } from './+layout.server';

const mocks = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

beforeEach(() => {
	mocks.env.APP_URL = 'https://moderaty.com';
});

test.each([
	['https://moderaty.com', 'https://moderaty.com'],
	['HTTPS://SELFHOST.example:443/', 'https://selfhost.example'],
	['http://localhost:5173/', 'http://localhost:5173']
])('blog canonical and sitemap agree for APP_URL %s, independently of the request host', async (appUrl, origin) => {
	mocks.env.APP_URL = appUrl;
	const data = await load({ url: new URL('https://preview.example/blogs/') } as never);
	expect(data).toEqual({ siteOrigin: origin });
	const Index = (await import('./+page.svelte')).default;
	const { head } = render(Index, { props: { data: { locale: 'en', siteOrigin: origin } } });
	expect(head).toContain(`rel="canonical" href="${origin}/blogs/"`);
	expect(sitemapXml()).toContain(`<loc>${origin}/blogs/</loc>`);
	expect(head).not.toContain('https://preview.example');
});

test.each([
	undefined,
	'https://[invalid',
	'https://user:synthetic-secret@example.com',
	'https://selfhost.example/path',
	'https://selfhost.example?token=synthetic-secret',
	'https://selfhost.example#fragment'
])('blog metadata rejects missing or invalid APP_URL %s instead of using the request origin', async (appUrl) => {
	mocks.env.APP_URL = appUrl;
	let thrown: unknown;
	try {
		await load({ url: new URL('https://preview.example/blogs/') } as never);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toMatchObject({
		status: 500,
		body: {
			message: appUrl === undefined
				? 'APP_URL is not configured'
				: 'APP_URL is not configured as a valid absolute http(s) origin'
		}
	});
	expect(JSON.stringify(thrown)).not.toContain('synthetic-secret');
});
