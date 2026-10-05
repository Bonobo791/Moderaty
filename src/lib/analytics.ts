type AnalyticsWindow = Window & { dataLayer?: Record<string, unknown>[] };
type AnalyticsConfig = { gtmId: string; hostname: string };
const scriptLoads = new WeakMap<Element, Promise<void>>();
const publicPaths = new Set(['/', '/pricing', '/privacy', '/terms', '/dpa']);

/** Only clean public pages may expose their URL and DOM to a container. */
export function isAnalyticsPage(url: URL): boolean {
	return publicPaths.has(url.pathname) && !url.search;
}

/** Checks cancellation, the current page and sensitive same-origin referrers. */
function canInitializeAnalytics(signal?: AbortSignal): boolean {
	if (signal?.aborted) return false;
	const url = new URL(window.location.href);
	if (!isAnalyticsPage(url)) return false;
	if (!document.referrer) return true;
	const referrer = new URL(document.referrer);
	return referrer.origin !== url.origin || isAnalyticsPage(referrer);
}

/** Rejects malformed public configuration before touching tracking globals. */
function validateConfig(config: unknown): AnalyticsConfig {
	if (config === null || typeof config !== 'object') throw new Error('Analytics configuration is invalid');
	const { gtmId, hostname } = config as Record<string, unknown>;
	if (typeof gtmId !== 'string' || !/^GTM-[A-Z0-9]+$/.test(gtmId) || typeof hostname !== 'string') {
		throw new Error('Analytics configuration is invalid');
	}
	return { gtmId, hostname };
}

/** Uses a browser hostname claim so configured aliases work with pinned ORIGIN. */
function configurationUrl(): string {
	// Use the browser's hostname: adapter-node can pin event.url to another ORIGIN.
	const url = new URL('/api/analytics', window.location.origin);
	url.searchParams.set('hostname', window.location.hostname);
	return url.toString();
}

/** Sends a payload-free diagnostic and preserves the original script rejection. */
async function reportScriptFailure(cause: unknown): Promise<never> {
	try {
		// No page URL, container ID, error text, or account data is sent.
		const response = await fetch(configurationUrl(), {
			method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(5000)
		});
		if (!response.ok) throw new Error('Analytics failure report failed');
	} catch (error_) {
		console.error('analytics failure reporting failed:', error_);
	}
	throw cause;
}

/** Inserts one async script whose actual load/error events settle its state. */
function insertScript(gtmId: string): Promise<void> {
	const src = new URL('https://www.googletagmanager.com/gtm.js');
	src.searchParams.set('id', gtmId);
	const script = document.createElement('script');
	script.id = 'moderaty-gtm';
	script.async = true;
	script.src = src.toString();
	const loading = new Promise<void>((resolve, reject) => {
		script.onload = () => resolve();
		script.onerror = reject.bind(null, new Error('Google Tag Manager failed to load'));
		document.head.appendChild(script);
	}).catch(reportScriptFailure);
	scriptLoads.set(script, loading);
	return loading;
}

/** Preserves dataLayer and shares the script's success or failure per document. */
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

/** Reads runtime settings with a timeout combined with caller cancellation. */
async function readConfiguration(signal?: AbortSignal): Promise<AnalyticsConfig | null> {
	const response = await fetch(configurationUrl(), {
		cache: 'no-store', credentials: 'omit',
		signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
	});
	if (!response.ok) throw new Error('Analytics configuration request failed');
	const body: unknown = await response.json();
	return body === null ? null : validateConfig(body);
}

/** Loads only for eligible documents on independently approved browser hosts. */
export async function loadAnalytics(signal?: AbortSignal): Promise<void> {
	if (!canInitializeAnalytics(signal)) return;
	const config = await readConfiguration(signal);
	if (config === null) return;
	// Recheck after async work: neither navigation nor a copied response may
	// activate tracking on a sensitive page or a different browser hostname.
	if (!canInitializeAnalytics(signal) || window.location.hostname !== config.hostname) return;
	await initializeAnalytics(config.gtmId);
}
