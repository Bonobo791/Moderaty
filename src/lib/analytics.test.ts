import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadAnalytics } from './analytics';

type Script = {
	id?: string;
	src?: string;
	async?: boolean;
	onload?: () => void;
	onerror?: () => void;
};

let scripts: Script[];
let browser: { location: URL; dataLayer?: Record<string, unknown>[] };
let scriptFails: boolean;
let response: Response;

beforeEach(() => {
	scripts = [];
	browser = { location: new URL('https://moderaty.example/privacy') };
	scriptFails = false;
	response = Response.json({ gtmId: 'GTM-TEST123', hostname: 'moderaty.example' });
	vi.stubGlobal('window', browser);
	vi.stubGlobal('document', {
		referrer: '',
		getElementById: (id: string) => scripts.find((script) => script.id === id),
		createElement: (tag: string) => {
			if (tag !== 'script') throw new Error(`unexpected element: ${tag}`);
			return {};
		},
		head: { appendChild: (script: Script) => {
			scripts.push(script);
			queueMicrotask(() => scriptFails ? script.onerror?.() : script.onload?.());
		} }
	});
	vi.stubGlobal('fetch', vi.fn(async () => response.clone()));
});
afterEach(() => vi.unstubAllGlobals());

function expectNoTracking() {
	expect(scripts).toEqual([]);
	expect(browser.dataLayer).toBeUndefined();
}

test('disabled configuration creates no tracking elements or dataLayer', async () => {
	response = Response.json(null);
	await loadAnalytics();
	expectNoTracking();
	expect(fetch).toHaveBeenCalledWith('https://moderaty.example/api/analytics?hostname=moderaty.example', expect.objectContaining({ cache: 'no-store', credentials: 'omit' }));
});

test('an approved browser host loads the supplied ID asynchronously and queues GTM initialization', async () => {
	await loadAnalytics();
	expect(scripts).toHaveLength(1);
	expect(scripts[0].src).toBe('https://www.googletagmanager.com/gtm.js?id=GTM-TEST123');
	expect(scripts[0].async).toBe(true);
	expect(browser.dataLayer).toEqual([{ 'gtm.start': expect.any(Number), event: 'gtm.js' }]);
});

test.each(['fork.example', 'www.moderaty.example', 'moderaty.example.evil.test', 'sub.moderaty.example', 'moderaty.example.'])(
	'copied official configuration makes no tracking request on another browser hostname: %s', async (hostname) => {
		browser.location.hostname = hostname;
		await loadAnalytics();
		expectNoTracking();
	}
);

test('existing dataLayer events are preserved and GTM is inserted once even with concurrent initialization', async () => {
	const existing = [{ event: 'existing-event' }];
	browser.dataLayer = existing;
	await Promise.all([loadAnalytics(), loadAnalytics()]);
	expect(scripts).toHaveLength(1);
	expect(browser.dataLayer).toBe(existing);
	expect(browser.dataLayer).toEqual([
		{ event: 'existing-event' }, { 'gtm.start': expect.any(Number), event: 'gtm.js' }
	]);
});

test.each([{}, [], false, 'GTM-TEST123', { gtmId: 'G-TEST123', hostname: 'moderaty.example' },
	{ gtmId: 'GTM-TEST123\n', hostname: 'moderaty.example' },
	{ gtmId: 'GTM-TEST123&x=1', hostname: 'moderaty.example' }, { gtmId: 'GTM-TEST123' }])(
	'malformed configuration cannot create tracking elements: %j', async (config) => {
		response = Response.json(config);
		await expect(loadAnalytics()).rejects.toThrow();
		expectNoTracking();
	}
);

test('a failed configuration request cannot insert GTM', async () => {
	response = new Response('service unavailable', { status: 503 });
	await expect(loadAnalytics()).rejects.toThrow();
	expectNoTracking();
});

test('a network failure fetching local configuration is reported and inserts nothing', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network unavailable'); }));
	await expect(loadAnalytics()).rejects.toThrow('network unavailable');
	expect(scripts).toEqual([]);
});

test('invalid JSON configuration is reported and inserts nothing', async () => {
	response = new Response('not JSON');
	await expect(loadAnalytics()).rejects.toThrow();
	expect(scripts).toEqual([]);
});

test('a blocked or failed GTM script rejects rather than claiming tracking loaded', async () => {
	scriptFails = true;
	await expect(loadAnalytics()).rejects.toThrow('Google Tag Manager failed to load');
	expect(scripts).toHaveLength(1);
});

test('all concurrent and later callers observe a GTM script failure', async () => {
	scriptFails = true;
	const results = await Promise.allSettled([loadAnalytics(), loadAnalytics()]);
	expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
	await expect(loadAnalytics()).rejects.toThrow('Google Tag Manager failed to load');
	expect(scripts).toHaveLength(1);
});

test.each([
	'/consent?state=oauth-secret', '/invite/invitation-secret', '/contact/verify?token=contact-secret',
	'/login', '/account-deleted', '/dashboard', '/account', '/org', '/channels/123', '/contact',
	'/privacy?token=secret', '/unknown'
])('sensitive or unrecognized page never even fetches analytics configuration: %s', async (path) => {
	browser.location = new URL(path, 'https://moderaty.example');
	await loadAnalytics();
	expect(fetch).not.toHaveBeenCalled();
	expectNoTracking();
});

test('navigation to a token page while configuration loads cannot initialize GTM', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => {
		browser.location = new URL('https://moderaty.example/consent?state=oauth-secret');
		return response.clone();
	}));
	await loadAnalytics();
	expectNoTracking();
});

test('returning from a same-origin token page cannot expose its URL through document.referrer', async () => {
	Object.assign(document, { referrer: 'https://moderaty.example/contact/verify?token=contact-secret' });
	await loadAnalytics();
	expect(fetch).not.toHaveBeenCalled();
	expectNoTracking();
});

test('navigation started before the router changes the URL cancels a pending GTM initialization', async () => {
	const controller = new AbortController();
	vi.stubGlobal('fetch', vi.fn(async () => {
		controller.abort();
		return response.clone();
	}));
	await loadAnalytics(controller.signal);
	expectNoTracking();
});

test.each(['/', '/pricing', '/privacy', '/terms', '/dpa', '/#regulars', '/privacy#s12'])(
	'public marketing/legal pages and section anchors retain analytics: %s', async (path) => {
		browser.location = new URL(path, 'https://moderaty.example');
		await loadAnalytics();
		expect(scripts).toHaveLength(1);
		expect(browser.dataLayer?.[0].event).toBe('gtm.js');
	}
);
