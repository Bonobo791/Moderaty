import type { RequestHandler } from '@sveltejs/kit';
import { sitemapXml } from '$lib/server/siteIndex';

export const GET: RequestHandler = () =>
	new Response(sitemapXml(), {
		headers: { 'content-type': 'application/xml; charset=utf-8' }
	});
