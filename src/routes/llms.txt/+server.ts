import type { RequestHandler } from '@sveltejs/kit';
import { llmsTxt } from '$lib/server/siteIndex';

// Markdown per llmstxt.org; served as text/plain to match the .txt suffix.
export const GET: RequestHandler = () =>
	new Response(llmsTxt(), {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
