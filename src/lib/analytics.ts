import { validateAnalyticsConfig } from './analytics-config';
import { buildPagePayload, parseMarketingClick, type AnalyticsConfig, type MarketingEvent, type MarketingPlacement, type PagePayload } from './analytics-policy';
import { browserRequestsPrivacy, getAnalyticsOptOut } from './analytics-preference';
export { getAnalyticsOptOut, setAnalyticsOptOut } from './analytics-preference';

export type AnalyticsClient = {
	pageview(url: URL, signal?: AbortSignal): Promise<'sent' | 'skipped'>;
	click(event: MarketingEvent, placement: MarketingPlacement): Promise<'sent' | 'skipped'>;
	stop(): void;
};
const failureMessage = 'Optional usage measurement is unavailable.';

/** Reads only reviewed marker pairs from links, including nested/keyboard clicks. */
export function readMarketingClick(event: MouseEvent) {
	if (!((event.type === 'click' && event.button === 0) || (event.type === 'auxclick' && event.button === 1))) return null;
	const target = event.target instanceof Element ? event.target : null;
	const link = target?.closest('a[data-moderaty-event][data-moderaty-placement]');
	return link ? parseMarketingClick(link.getAttribute('data-moderaty-event'), link.getAttribute('data-moderaty-placement')) : null;
}

/** Exact browser claim; supports aliases with adapter-node's pinned ORIGIN. */
function configurationUrl(): string {
	const url = new URL('/api/analytics', window.location.origin);
	url.searchParams.set('hostname', window.location.hostname);
	return url.href;
}

/** Independent deadline composed with all caller cancellation, never substituted. */
function deadline(...signals: (AbortSignal | undefined)[]): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(5000), ...signals.filter((signal): signal is AbortSignal => signal !== undefined)]);
}

/** One document owns its safe-page latch, configuration, deduplication and cache. */
export function createAnalyticsClient(options: { onFailure: () => void }): AnalyticsClient {
	let stopped = false;
	let generation = 0;
	let config: AnalyticsConfig | null = null;
	let cache: string | undefined;
	let lastUrl: string | undefined;
	let reported = false;
	const pending = new Set<AbortController>();

	function stop(): void {
		stopped = true; generation++; cache = undefined; config = null;
		for (const controller of pending) controller.abort();
		pending.clear();
	}

	/** Checks the current browser document without needing runtime settings. */
	function currentPage(): PagePayload | null {
		if (stopped) return null;
		try {
			if (browserRequestsPrivacy() || getAnalyticsOptOut()) { stop(); return null; }
		} catch {
			stop(); console.error('analytics preference failed'); options.onFailure(); return null;
		}
		const url = new URL(window.location.href);
		const page = buildPagePayload(url, document.referrer, { umamiUrl: '', websiteId: '', hostname: url.hostname });
		if (!page) stop();
		return page;
	}
	// A document beginning on a private route/referrer is permanently ineligible.
	currentPage();

	/** Reports only a generic signal, once per document, without raw error details. */
	async function fail(): Promise<never> {
		if (!stopped) {
			console.error('analytics collection failed');
			options.onFailure();
			if (!reported) {
				reported = true;
				try {
					const response = await fetch(configurationUrl(), {
						method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: deadline()
					});
					if (!response.ok) throw new Error(failureMessage);
				} catch {
					console.error('analytics failure reporting failed');
				}
			}
		}
		throw new Error(failureMessage);
	}

	/** Re-reads runtime settings for changed public URLs, with bounded cancellation. */
	async function readConfiguration(signal?: AbortSignal): Promise<AnalyticsConfig | null> {
		const controller = new AbortController(); pending.add(controller);
		try {
			const response = await fetch(configurationUrl(), {
				cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: deadline(signal, controller.signal)
			});
			if (!response.ok) throw new Error(failureMessage);
			const body: unknown = await response.json();
			return body === null ? null : validateAnalyticsConfig(body);
		} finally {
			pending.delete(controller);
		}
	}

	/** Discards session cache whenever public measurement settings change. */
	function useConfiguration(next: AnalyticsConfig | null): void {
		if (JSON.stringify(next) !== JSON.stringify(config)) { cache = undefined; generation++; }
		config = next;
	}

	/** Sends an immutable public payload; late results cannot restore discarded state. */
	async function send(payload: PagePayload & { name?: MarketingEvent; data?: { placement: MarketingPlacement } }, signal?: AbortSignal): Promise<'sent' | 'skipped'> {
		if (!config) return 'skipped';
		const started = generation;
		const url = new URL('/api/send', config.umamiUrl).href;
		const body = JSON.stringify({ type: 'event', payload });
		try {
			const response = await fetch(url, {
				method: 'POST', headers: { 'content-type': 'application/json', ...(cache ? { 'x-umami-cache': cache } : {}) },
				body, credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true, signal: deadline(signal)
			});
			if (!response.ok) throw new Error(failureMessage);
			const result: unknown = await response.json();
			if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(failureMessage);
			const fields = result as Record<string, unknown>;
			if (fields.beep === 'boop' && fields.cache === undefined) return 'skipped';
			if (typeof fields.cache !== 'string' || !fields.cache.length || fields.cache.length > 4096) throw new Error(failureMessage);
			if (!stopped && generation === started) cache = fields.cache;
			return 'sent';
		} catch {
			if (signal?.aborted) return 'skipped';
			return fail();
		}
	}

	return {
		stop,
		async pageview(url, signal) {
			const current = currentPage();
			const page = buildPagePayload(url, document.referrer, { umamiUrl: '', websiteId: '', hostname: window.location.hostname });
			if (!current || !page || signal?.aborted || page.url !== current.url || page.url === lastUrl) return 'skipped';
			lastUrl = page.url;
			try {
				const next = await readConfiguration(signal);
				// Both browser hostname and current safe URL are checked after the await.
				if (signal?.aborted || currentPage()?.url !== page.url) return 'skipped';
				if (next && next.hostname !== window.location.hostname) return 'skipped';
				useConfiguration(next);
				if (!next) return 'skipped';
				const payload = buildPagePayload(new URL(window.location.href), document.referrer, next);
				return payload ? send(payload, signal) : 'skipped';
			} catch {
				if (stopped || signal?.aborted) return 'skipped';
				return fail();
			}
		},
		click(event, placement) {
			if (!currentPage() || !config) return Promise.resolve('skipped');
			const pair = parseMarketingClick(event, placement);
			const payload = buildPagePayload(new URL(window.location.href), document.referrer, config);
			// Start immediately. The route effect's cancellation is deliberately absent.
			return pair && payload ? send({ ...payload, name: pair.name, data: { placement: pair.placement } }) : Promise.resolve('skipped');
		}
	};
}
