type AnalyticsWindow = Window & { dataLayer?: Record<string, unknown>[] };
type AnalyticsConfig = { gtmId: string; hostname: string };
const scriptLoads = new WeakMap<Element, Promise<void>>();
const publicPaths = new Set(['/', '/pricing', '/privacy', '/terms', '/dpa']);

/** Only clean public pages may expose their URL and DOM to a container. */
export function isAnalyticsPage(url: URL): boolean {
	return publicPaths.has(url.pathname) && !url.search;
}

function canInitializeAnalytics(): boolean {
	const url = new URL(window.location.href);
	if (!isAnalyticsPage(url)) return false;
	if (!document.referrer) return true;
	const referrer = new URL(document.referrer);
	return referrer.origin !== url.origin || isAnalyticsPage(referrer);
}

function validateConfig(config: unknown): AnalyticsConfig {
	if (config === null || typeof config !== 'object') throw new Error('Analytics configuration is invalid');
	const { gtmId, hostname } = config as Record<string, unknown>;
	if (typeof gtmId !== 'string' || !/^GTM-[A-Z0-9]+$/.test(gtmId) || typeof hostname !== 'string') {
		throw new Error('Analytics configuration is invalid');
	}
	return { gtmId, hostname };
}

function insertScript(gtmId: string): Promise<void> {
	const src = new URL('https://www.googletagmanager.com/gtm.js');
	src.searchParams.set('id', gtmId);
	const script = document.createElement('script');
	script.id = 'moderaty-gtm';
	script.async = true;
	script.src = src.toString();
	const loading = new Promise<void>((resolve, reject) => {
		script.onload = () => resolve();
		script.onerror = () => reject(new Error('Google Tag Manager failed to load'));
		document.head.appendChild(script);
	});
	scriptLoads.set(script, loading);
	return loading;
}

function initializeAnalytics(gtmId: string): Promise<void> {
	const existing = document.getElementById('moderaty-gtm');
	if (existing) {
		const loading = scriptLoads.get(existing);
		if (loading === undefined) throw new Error('Google Tag Manager script state is unknown');
		return loading;
	}
	const analyticsWindow = window as AnalyticsWindow;
	analyticsWindow.dataLayer ??= [];
	analyticsWindow.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
	return insertScript(gtmId);
}

async function readConfiguration(signal?: AbortSignal): Promise<AnalyticsConfig | null> {
	// Use the browser's hostname: adapter-node can pin event.url to another ORIGIN.
	const url = new URL('/api/analytics', window.location.origin);
	url.searchParams.set('hostname', window.location.hostname);
	const response = await fetch(url.toString(), {
		cache: 'no-store', credentials: 'omit',
		signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
	});
	if (!response.ok) throw new Error('Analytics configuration request failed');
	const body: unknown = await response.json();
	return body === null ? null : validateConfig(body);
}

export async function loadAnalytics(signal?: AbortSignal): Promise<void> {
	if (signal?.aborted || !canInitializeAnalytics()) return;
	const config = await readConfiguration(signal);
	if (config === null) return;
	// Recheck after async work: neither navigation nor a copied response may
	// activate tracking on a sensitive page or a different browser hostname.
	if (signal?.aborted || !canInitializeAnalytics() || window.location.hostname !== config.hostname) return;
	await initializeAnalytics(config.gtmId);
}
