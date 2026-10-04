type AnalyticsWindow = Window & { dataLayer?: Record<string, unknown>[] };
const scriptLoads = new WeakMap<Element, Promise<void>>();

export async function loadAnalytics(): Promise<void> {
	const response = await fetch('/api/analytics', {
		cache: 'no-store',
		credentials: 'omit',
		signal: AbortSignal.timeout(5000)
	});
	if (!response.ok) throw new Error('Analytics configuration request failed');
	const config: unknown = await response.json();
	if (config === null) return;
	if (
		typeof config !== 'object' ||
		!('gtmId' in config) || typeof config.gtmId !== 'string' ||
		!/^GTM-[A-Z0-9]+$/.test(config.gtmId) ||
		!('hostname' in config) || typeof config.hostname !== 'string'
	) {
		throw new Error('Analytics configuration is invalid');
	}
	// This browser check is mandatory even after the server's gate: copied
	// responses, a CDN mistake or adapter-node's pinned ORIGIN must never
	// activate this deployment's container on a different hostname.
	if (window.location.hostname !== config.hostname) return;
	const existing = document.getElementById('moderaty-gtm');
	if (existing) {
		const loading = scriptLoads.get(existing);
		if (!loading) throw new Error('Google Tag Manager script state is unknown');
		return loading;
	}

	const analyticsWindow = window as AnalyticsWindow;
	analyticsWindow.dataLayer ??= [];
	analyticsWindow.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
	const src = new URL('https://www.googletagmanager.com/gtm.js');
	src.searchParams.set('id', config.gtmId);
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
	await loading;
}
