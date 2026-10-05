import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export const prerender = false;
const headers = { 'cache-control': 'no-store' };
const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function invalidHostname(hostname: string): boolean {
	return hostname.length > 253 || hostname.split('.').some((label) => !labelPattern.test(label));
}

function runtimeConfiguration() {
	if (!env.ANALYTICS_ENABLED || env.ANALYTICS_ENABLED === 'false') return null;
	if (env.ANALYTICS_ENABLED !== 'true') {
		throw new Error('ANALYTICS_ENABLED must be true or false');
	}
	if (!env.GTM_ID || !/^GTM-[A-Z0-9]+$/.test(env.GTM_ID)) {
		throw new Error('GTM_ID must be a valid Google Tag Manager container ID');
	}
	const hostnames = (env.GTM_ALLOWED_HOSTNAMES ?? '').split(',').map((host) => host.trim().toLowerCase());
	if (hostnames.some(invalidHostname)) {
		throw new Error('GTM_ALLOWED_HOSTNAMES must contain comma-separated exact DNS hostnames');
	}
	return { gtmId: env.GTM_ID, hostnames };
}

// Public pages are prerendered. Read deployment settings only at runtime.
export const GET: RequestHandler = ({ url }) => {
	try {
		const config = runtimeConfiguration();
		if (config === null) return json(null, { headers });
		// This is an untrusted claim, restricted to the operator's exact allowlist.
		// The browser independently checks the returned hostname before loading GTM.
		const hostname = url.searchParams.get('hostname') ?? url.hostname;
		if (!config.hostnames.includes(hostname)) return json(null, { headers });
		return json({ gtmId: config.gtmId, hostname }, { headers });
	} catch (cause) {
		console.error('analytics configuration failed:', cause);
		return json({ message: 'Optional usage measurement is unavailable.' }, { status: 503, headers });
	}
};
