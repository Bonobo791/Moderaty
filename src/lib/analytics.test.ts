import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadAnalytics } from './analytics';

type Script = {
	id?: string;
	src?: string;
	async?: boolean;
	onload: () => void;
	onerror: () => void;
};

let scripts: Script[];
let browser: { location: URL; dataLayer?: Record<string, unknown>[] };
let scriptFails: boolean;
let response: Response;

beforeEach(() => {
	scripts = [];
	const elements = new Map<string | undefined, Script>();
	browser = { location: new URL('https://moderaty.example/privacy') };
	scriptFails = false;
	response = Response.json({ gtmId: 'GTM-TEST123', hostname: 'moderaty.example' });
	vi.stubGlobal('window', browser);
	vi.stubGlobal('document', {
		referrer: '',
		getElementById: elements.get.bind(elements),
		createElement: vi.fn().mockReturnValue({}),
		head: { appendChild: (script: Script) => {
			scripts.push(script);
			elements.set(script.id, script);
			queueMicrotask(scriptFails ? script.onerror : script.onload);
		} }
	});
	vi.stubGlobal('fetch', vi.fn(async () => response.clone()));
});
afterEach(() => vi.unstubAllGlobals());

function expectNoTracking() {
	expect(scripts).toEqual([]);
	expect(browser.dataLayer).toBeUndefined();
	expect(document.createElement).not.toHaveBeenCalled();
}

test('disabled configuration creates no tracking elements or dataLayer', async () => {
	response = Response.json(null);
	await loadAnalytics();
	expectNoTracking();
	expect(fetch).toHaveBeenCalledWith('https://moderaty.example/api/analytics?hostname=moderaty.example', expect.objectContaining({ cache: 'no-store', credentials: 'omit' }));
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

test.each([
	['empty object', vi.fn().mockResolvedValue(Response.json({})), 'Analytics configuration is invalid'],
	['array', vi.fn().mockResolvedValue(Response.json([])), 'Analytics configuration is invalid'],
	['boolean', vi.fn().mockResolvedValue(Response.json(false)), 'Analytics configuration is invalid'],
	['string', vi.fn().mockResolvedValue(Response.json('GTM-TEST123')), 'Analytics configuration is invalid'],
	['wrong ID prefix', vi.fn().mockResolvedValue(Response.json({ gtmId: 'G-TEST123', hostname: 'moderaty.example' })), 'Analytics configuration is invalid'],
	['ID newline', vi.fn().mockResolvedValue(Response.json({ gtmId: 'GTM-TEST123\n', hostname: 'moderaty.example' })), 'Analytics configuration is invalid'],
	['ID query injection', vi.fn().mockResolvedValue(Response.json({ gtmId: 'GTM-TEST123&x=1', hostname: 'moderaty.example' })), 'Analytics configuration is invalid'],
	['missing hostname', vi.fn().mockResolvedValue(Response.json({ gtmId: 'GTM-TEST123' })), 'Analytics configuration is invalid'],
	['HTTP failure', vi.fn().mockResolvedValue(new Response('service unavailable', { status: 503 })), 'Analytics configuration request failed'],
	['network failure', vi.fn().mockRejectedValue(new Error('network unavailable')), 'network unavailable'],
	['invalid JSON', vi.fn().mockResolvedValue(new Response('not JSON')), SyntaxError]
] as const)('configuration failure cannot create tracking elements: %s', async (_name, fetchResult, failure) => {
	vi.stubGlobal('fetch', fetchResult);
	await expect(loadAnalytics()).rejects.toThrow(failure);
	expectNoTracking();
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
		expect(document.createElement).toHaveBeenCalledWith('script');
		expect(scripts[0].src).toBe('https://www.googletagmanager.com/gtm.js?id=GTM-TEST123');
		expect(scripts[0].async).toBe(true);
		expect(browser.dataLayer).toEqual([{ 'gtm.start': expect.any(Number), event: 'gtm.js' }]);
	}
);
