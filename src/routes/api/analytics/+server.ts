import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export const prerender = false;

const headers = { 'cache-control': 'no-store' };
const hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Public pages are prerendered. Fetch deployment settings at runtime so no
// container ID can be captured in their HTML or the distributed client build.
export const GET: RequestHandler = ({ url }) => {
	try {
		if (!env.ANALYTICS_ENABLED || env.ANALYTICS_ENABLED === 'false') {
			return json(null, { headers });
		}
		if (env.ANALYTICS_ENABLED !== 'true') {
			throw new Error('ANALYTICS_ENABLED must be true or false');
		}
		if (!env.GTM_ID || !/^GTM-[A-Z0-9]+$/.test(env.GTM_ID)) {
			throw new Error('GTM_ID must be a valid Google Tag Manager container ID');
		}
		const hostnames = (env.GTM_ALLOWED_HOSTNAMES ?? '').split(',').map((host) => host.trim().toLowerCase());
		if (hostnames.some((host) => host.length > 253 || !hostnamePattern.test(host))) {
			throw new Error('GTM_ALLOWED_HOSTNAMES must contain comma-separated exact DNS hostnames');
		}
		if (!hostnames.includes(url.hostname)) return json(null, { headers });
		return json({ gtmId: env.GTM_ID, hostname: url.hostname }, { headers });
	} catch (cause) {
		console.error('analytics configuration failed:', cause);
		return json({ message: 'Optional usage measurement is unavailable.' }, { status: 503, headers });
	}
};
