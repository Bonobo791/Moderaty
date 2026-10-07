import type { AnalyticsConfig } from './analytics-policy';

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Matches exact DNS hostnames within Umami's 100-character collector bound. */
export function isAnalyticsHostname(value: string): boolean {
	return value.length > 0 && value.length <= 100 && value.split('.').every((part) => label.test(part));
}

/** Validates the same public settings at both server and browser boundaries. */
export function validateAnalyticsConfig(value: unknown): AnalyticsConfig {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid analytics configuration');
	const { umamiUrl, websiteId, hostname } = value as Record<string, unknown>;
	if (typeof hostname !== 'string' || !isAnalyticsHostname(hostname)) throw new Error('Invalid analytics hostname');
	if (typeof websiteId !== 'string' || !uuid.test(websiteId)) throw new Error('Invalid analytics website UUID');
	if (typeof umamiUrl !== 'string' || /\s/.test(umamiUrl)) throw new Error('Invalid analytics HTTPS origin');
	let origin: URL;
	try { origin = new URL(umamiUrl); } catch { throw new Error('Invalid analytics HTTPS origin'); }
	if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
		throw new Error('Invalid analytics HTTPS origin');
	}
	return { umamiUrl: origin.origin, websiteId: websiteId.toLowerCase(), hostname };
}
