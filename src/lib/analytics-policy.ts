export type AnalyticsConfig = { umamiUrl: string; websiteId: string; hostname: string };
export type PagePayload = { website: string; hostname: string; url: string; title: string; referrer: string };
export type MarketingEvent = 'connect_click' | 'pricing_click' | 'source_click' | 'contact_click';
export type MarketingPlacement = 'nav' | 'nav_mobile' | 'hero' | 'final_cta' | 'plan_hosted' | 'plan_lifetime' | 'home_pricing' | 'footer' | 'plan_self_hosted' | 'pricing_contact';

const titles = new Map([
	['/', 'Home'], ['/pricing', 'Pricing'], ['/privacy', 'Privacy'], ['/terms', 'Terms'], ['/dpa', 'DPA']
]);
const sensitiveKeys = new Set(['code', 'state', 'token', 'access_token', 'refresh_token', 'id_token', 'email', 'invite', 'session', 'password', 'reset', 'verification']);

// Actual nonidentifying campaign slugs must be reviewed and added explicitly.
export const APPROVED_CAMPAIGNS: readonly string[] = [];
const campaigns: Readonly<Record<string, readonly string[]>> = {
	utm_source: ['google', 'youtube', 'instagram', 'facebook', 'linkedin', 'newsletter'],
	utm_medium: ['organic', 'social', 'cpc', 'email', 'referral'],
	utm_campaign: APPROVED_CAMPAIGNS
};
const placements: Readonly<Record<MarketingEvent, readonly MarketingPlacement[]>> = {
	connect_click: ['nav', 'nav_mobile', 'hero', 'final_cta', 'plan_hosted', 'plan_lifetime'],
	pricing_click: ['nav', 'nav_mobile', 'home_pricing', 'footer'],
	source_click: ['nav', 'nav_mobile', 'footer', 'plan_self_hosted'],
	contact_click: ['footer', 'pricing_contact']
};

/** Allows only public HTTP(S) pages without parsed credentials or sensitive keys. */
export function isAnalyticsPage(url: URL): boolean {
	return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
		titles.has(url.pathname) && ![...url.searchParams.keys()].some((key) => sensitiveKeys.has(key.toLowerCase()));
}

/** Constructs a canonical path from reviewed UTM values, discarding duplicates. */
function publicPath(url: URL): string {
	const query = new URLSearchParams();
	for (const [key, approved] of Object.entries(campaigns)) {
		const values = url.searchParams.getAll(key);
		if (values.length === 1 && approved.includes(values[0])) query.set(key, values[0]);
	}
	return url.pathname + (query.size ? `?${query}` : '');
}

/** Identifies a pageview without reacting to discarded query data or fragments. */
export function analyticsPageUrl(url: URL): string | null {
	return isAnalyticsPage(url) ? publicPath(url) : null;
}

/** Null suppresses a document reached from a private or unparseable referrer. */
function publicReferrer(value: string, url: URL): string | null {
	if (!value) return '';
	try {
		const referrer = new URL(value);
		if (referrer.origin === url.origin) return isAnalyticsPage(referrer) ? '' : null;
		return ['http:', 'https:'].includes(referrer.protocol) ? referrer.origin : '';
	} catch {
		return null;
	}
}

/** Freezes the permitted data shape without forwarding DOM text or location.href. */
export function buildPagePayload(url: URL, referrer: string, config: AnalyticsConfig): PagePayload | null {
	if (!isAnalyticsPage(url) || url.hostname !== config.hostname) return null;
	const safeReferrer = publicReferrer(referrer, url);
	if (safeReferrer === null) return null;
	return { website: config.websiteId, hostname: config.hostname, url: publicPath(url), title: titles.get(url.pathname)!, referrer: safeReferrer };
}

/** Accepts only a static event paired with one of its reviewed placements. */
export function parseMarketingClick(name: string | null, placement: string | null): { name: MarketingEvent; placement: MarketingPlacement } | null {
	if (!name || !placement || !Object.hasOwn(placements, name)) return null;
	const event = name as MarketingEvent;
	return placements[event].includes(placement as MarketingPlacement) ? { name: event, placement: placement as MarketingPlacement } : null;
}
