import type { RequestHandler } from '@sveltejs/kit';
import { robotsTxt } from '$lib/server/siteIndex';

export const GET: RequestHandler = () =>
	new Response(robotsTxt(), {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
