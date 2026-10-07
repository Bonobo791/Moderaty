import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { isAnalyticsHostname, validateAnalyticsConfig } from '$lib/analytics-config';

export const prerender = false;
const headers = { 'cache-control': 'no-store' };
const browserFailureMessage = 'analytics browser initialization failed';
let nextDiagnosticLog = 0;
/** Keeps analytics off by default and validates enabled deployment settings. */
function runtimeConfiguration() {
	if ([undefined, '', 'false'].includes(env.ANALYTICS_ENABLED)) return null;
	if (env.ANALYTICS_ENABLED !== 'true') {
		throw new Error('ANALYTICS_ENABLED must be true or false');
	}
	const hostnames = (env.ANALYTICS_ALLOWED_HOSTNAMES ?? '').split(',').map((host) => host.trim().toLowerCase());
	if (hostnames.some((host) => !isAnalyticsHostname(host))) {
		throw new Error('ANALYTICS_ALLOWED_HOSTNAMES must contain exact DNS hostnames of at most 100 characters');
	}
	const settings = validateAnalyticsConfig({ umamiUrl: env.UMAMI_URL, websiteId: env.UMAMI_WEBSITE_ID, hostname: hostnames[0] });
	return { ...settings, hostnames };
}

/** Coalesces analytics diagnostics per worker without retaining caller data. */
function recordDiagnostic(...details: unknown[]): void {
	const now = Date.now();
	if (now >= nextDiagnosticLog) {
		nextDiagnosticLog = now + 60_000;
		console.error(...details);
	}
}

/** Serves uncached runtime config and accepts generic, hostname-gated reports. */
export const GET: RequestHandler = ({ url, request }) => {
	try {
		const config = runtimeConfiguration();
		if (config === null) return json(null, { headers });
		// This is an untrusted claim, restricted to the operator's exact allowlist.
		// The browser independently checks the returned hostname before collection.
		const hostname = url.searchParams.get('hostname') ?? url.hostname;
		if (!config.hostnames.includes(hostname)) return json(null, { headers });
		if (request.method === 'POST') {
			// Ignore request bodies: never log client error text, URLs, or tokens.
			// One diagnostic per minute per worker, with constant memory and no
			// caller-controlled keys that can evade the limit or fill a Map.
			recordDiagnostic(browserFailureMessage);
			return new Response(null, { status: 204, headers });
		}
		return json({ umamiUrl: config.umamiUrl, websiteId: config.websiteId, hostname }, { headers });
	} catch (cause) {
		recordDiagnostic('analytics configuration failed:', cause);
		return json({ message: 'Optional usage measurement is unavailable.' }, { status: 503, headers });
	}
};

// Apply the same runtime and exact-hostname gates to generic failure reports.
export const POST = GET;
