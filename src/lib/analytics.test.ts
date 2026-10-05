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
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** Verifies skipped initialization creates neither tracking DOM nor dataLayer. */
function expectNoTracking() {
	expect(scripts).toEqual([]);
	expect(browser.dataLayer).toBeUndefined();
	expect(document.createElement).not.toHaveBeenCalled();
}

const enabledConfig = { gtmId: 'GTM-TEST123', hostname: 'moderaty.example' };
test.each([
	['moderaty.example', null],
	['fork.example', enabledConfig],
	['www.moderaty.example', enabledConfig],
	['moderaty.example.evil.test', enabledConfig],
	['sub.moderaty.example', enabledConfig],
	['moderaty.example.', enabledConfig]
] as const)(
	'disabled or copied configuration creates no tracking on browser hostname %s', async (hostname, config) => {
		browser.location.hostname = hostname;
		response = Response.json(config);
		await loadAnalytics();
		expectNoTracking();
		expect(fetch).toHaveBeenCalledWith(new URL(`/api/analytics?hostname=${hostname}`, browser.location).href,
			expect.objectContaining({ cache: 'no-store', credentials: 'omit' }));
	}
);

test.each([
	[false, { status: 'fulfilled', value: undefined }, 3],
	[true, { status: 'rejected', reason: new Error('Google Tag Manager failed to load') }, 4]
] as const)('concurrent and later initialization shares one script (failure: %s)', async (fails, outcome, requests) => {
	scriptFails = fails;
	const existing = [{ event: 'existing-event' }];
	browser.dataLayer = existing;
	const results = await Promise.allSettled([loadAnalytics(), loadAnalytics()]);
	const later = await Promise.allSettled([loadAnalytics()]);
	expect([...results, ...later]).toEqual([outcome, outcome, outcome]);
	expect(scripts).toHaveLength(1);
	expect(browser.dataLayer).toBe(existing);
	expect(browser.dataLayer).toEqual([
		{ event: 'existing-event' }, { 'gtm.start': expect.any(Number), event: 'gtm.js' }
	]);
	// Configuration reads share one script and, on failure, one server report.
	expect(fetch).toHaveBeenCalledTimes(requests);
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

test.each([
	['delivered', vi.fn().mockResolvedValue(new Response(null, { status: 204 })), 0],
	['HTTP failure', vi.fn().mockResolvedValue(new Response(null, { status: 503 })), 1],
	['network failure', vi.fn().mockRejectedValue(new Error('report unavailable')), 1]
] as const)(
	'script failures report only a generic signal to the server: %s', async (_delivery, reporting, logs) => {
		scriptFails = true;
		const log = vi.spyOn(console, 'error').mockImplementation(vi.fn());
		const fetcher = vi.fn().mockResolvedValueOnce(response.clone()).mockImplementationOnce(reporting);
		vi.stubGlobal('fetch', fetcher);
		await expect(loadAnalytics()).rejects.toThrow('Google Tag Manager failed to load');
		expect(fetcher).toHaveBeenLastCalledWith('https://moderaty.example/api/analytics?hostname=moderaty.example', {
			method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: expect.any(AbortSignal)
		});
		expect(log.mock.calls).toHaveLength(logs);
	}
);

test('a slow script can finish loading without a premature failure report', async () => {
	vi.useFakeTimers();
	const appended = vi.spyOn(document.head, 'appendChild').mockReturnValue({} as HTMLElement);
	const outcome = Promise.allSettled([loadAnalytics()]);
	await vi.waitFor(() => expect(appended).toHaveBeenCalledOnce());
	await vi.advanceTimersByTimeAsync(6000);
	expect(fetch).toHaveBeenCalledOnce();
	(appended.mock.calls[0][0] as unknown as Script).onload();
	expect(await outcome).toEqual([{ status: 'fulfilled', value: undefined }]);
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

test.each([
	['', 'https://moderaty.example/consent?state=oauth-secret', false, 1],
	['https://moderaty.example/contact/verify?token=contact-secret', 'https://moderaty.example/privacy', false, 0],
	['', 'https://moderaty.example/privacy', true, 1]
] as const)('sensitive navigation/referrers and cancellation cannot initialize GTM: %s, %s, %s', async (referrer, destination, aborted, requests) => {
	const controller = new AbortController();
	Object.assign(document, { referrer });
	vi.stubGlobal('fetch', vi.fn(async () => {
		browser.location = new URL(destination);
		if (aborted) controller.abort();
		return response.clone();
	}));
	await loadAnalytics(controller.signal);
	expect(fetch).toHaveBeenCalledTimes(requests);
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
