type AnalyticsWindow = Window & { dataLayer?: Record<string, unknown>[] };
type AnalyticsConfig = { gtmId: string; hostname: string };
const scriptLoads = new WeakMap<Element, Promise<void>>();
const publicPaths = new Set(['/', '/pricing', '/privacy', '/terms', '/dpa']);

/** Only clean public pages may expose their URL and DOM to a container. */
export function isAnalyticsPage(url: URL): boolean {
	return publicPaths.has(url.pathname) && !url.search;
}

function canInitializeAnalytics(signal?: AbortSignal): boolean {
	if (signal?.aborted) return false;
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

function configurationUrl(): string {
	// Use the browser's hostname: adapter-node can pin event.url to another ORIGIN.
	const url = new URL('/api/analytics', window.location.origin);
	url.searchParams.set('hostname', window.location.hostname);
	return url.toString();
}

async function reportScriptFailure(cause: unknown): Promise<never> {
	try {
		// No page URL, container ID, error text, or account data is sent.
		const response = await fetch(configurationUrl(), {
			method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(5000)
		});
		if (!response.ok) throw new Error('Analytics failure report failed');
	} catch (reportCause) {
		console.error('analytics failure reporting failed:', reportCause);
	}
	throw cause;
}

function insertScript(gtmId: string): Promise<void> {
	const src = new URL('https://www.googletagmanager.com/gtm.js');
	src.searchParams.set('id', gtmId);
	const script = document.createElement('script');
	script.id = 'moderaty-gtm';
	script.async = true;
	script.src = src.toString();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const loading = new Promise<void>((resolve, reject) => {
		const fail = reject.bind(null, new Error('Google Tag Manager failed to load'));
		timer = setTimeout(fail, 5000);
		script.onload = () => resolve();
		script.onerror = fail;
		document.head.appendChild(script);
	}).finally(() => clearTimeout(timer)).catch(reportScriptFailure);
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
	const response = await fetch(configurationUrl(), {
		cache: 'no-store', credentials: 'omit',
		signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
	});
	if (!response.ok) throw new Error('Analytics configuration request failed');
	const body: unknown = await response.json();
	return body === null ? null : validateConfig(body);
}

export async function loadAnalytics(signal?: AbortSignal): Promise<void> {
	if (!canInitializeAnalytics(signal)) return;
	const config = await readConfiguration(signal);
	if (config === null) return;
	// Recheck after async work: neither navigation nor a copied response may
	// activate tracking on a sensitive page or a different browser hostname.
	if (!canInitializeAnalytics(signal) || window.location.hostname !== config.hostname) return;
	await initializeAnalytics(config.gtmId);
}
