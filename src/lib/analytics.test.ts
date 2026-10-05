import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createAnalyticsClient, getAnalyticsOptOut, setAnalyticsOptOut, readMarketingClick } from './analytics';

const config = { umamiUrl: 'https://collector.example', websiteId: '11111111-2222-4333-8444-555555555555', hostname: 'moderaty.example' };
let browser: { location: URL; localStorage: Storage; dispatchEvent: (event: Event) => boolean };
let referrer: string;
let requests: { url: string; options: RequestInit; body?: Record<string, unknown> }[];
let configBody: unknown;
let collector: () => Promise<Response>;
let failure: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
	const storage = new Map<string, string>();
	browser = { location: new URL('https://moderaty.example/'), localStorage: {
		getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); }
	} as Storage, dispatchEvent: vi.fn().mockReturnValue(true) };
	vi.stubGlobal('navigator', { doNotTrack: null, globalPrivacyControl: false });
	referrer = ''; requests = []; configBody = config;
	collector = async () => Response.json({ cache: 'memory-token', sessionId: 'ignored', visitId: 'ignored' });
	failure = vi.fn<() => void>();
	vi.stubGlobal('window', browser);
	vi.stubGlobal('document', { get referrer() { return referrer; }, createElement: vi.fn() });
	vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
		requests.push({ url, options, ...(options.body ? { body: JSON.parse(options.body as string) } : {}) });
		if (url.startsWith(config.umamiUrl)) return collector();
		return options.method === 'POST' ? new Response(null, { status: 204 }) : Response.json(configBody);
	}));
	vi.spyOn(console, 'error').mockImplementation(vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const sent = () => requests.filter((request) => request.url.startsWith(config.umamiUrl));
const client = () => createAnalyticsClient({ onFailure: failure });
const view = (instance: ReturnType<typeof client>) => instance.pageview(new URL(browser.location));
const navigate = (path: string) => { browser.location = new URL(path, 'https://moderaty.example'); };
const expectedPayload = (url = '/', title = 'Home', extra = {}) => ({ website: config.websiteId, hostname: config.hostname, url, title, referrer: '', ...extra });
const logs = () => vi.mocked(console.error).mock.calls.flat().join(' ');

test.each([null, { ...config, hostname: 'fork.example' }, { ...config, hostname: 'www.moderaty.example' }])('disabled/copied configuration makes no collector request: %j', async (body) => {
	configBody = body; expect(await view(client())).toBe('skipped'); expect(sent()).toEqual([]);
	expect(document.createElement).not.toHaveBeenCalled(); expect(browser).not.toHaveProperty('dataLayer'); expect(failure).not.toHaveBeenCalled();
});
test('constructs the complete permitted request with no cookies, referrer or identity fields', async () => {
	navigate('/pricing?utm_source=google&utm_medium=cpc&gclid=secret#section'); referrer = 'https://ref.example/private?email=secret';
	expect(await view(client())).toBe('sent');
	expect(requests[0]).toEqual({ url: 'https://moderaty.example/api/analytics?hostname=moderaty.example', options: {
		cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: expect.any(AbortSignal)
	} });
	const body = { type: 'event', payload: expectedPayload('/pricing?utm_source=google&utm_medium=cpc', 'Pricing', { referrer: 'https://ref.example' }) };
	expect(sent()).toEqual([{ url: 'https://collector.example/api/send', body, options: {
		method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
		headers: { 'content-type': 'application/json' }, signal: expect.any(AbortSignal), body: JSON.stringify(body)
	} }]);
	expect(document.createElement).not.toHaveBeenCalled();
});
test('counts initially and per changed canonical public URL, including Back, without duplicates', async () => {
	const instance = client(); expect(await Promise.all([view(instance), view(instance)])).toEqual(['sent', 'skipped']);
	for (const path of ['/#section', '/?ignored=secret', '/pricing', '/pricing#section', '/', '/?utm_medium=email&utm_source=newsletter', '/?utm_source=newsletter&utm_medium=email']) {
		navigate(path); await view(instance);
	}
	expect(sent().map((request) => (request.body?.payload as { url: string }).url)).toEqual(['/', '/pricing', '/', '/?utm_source=newsletter&utm_medium=email']);
});
test.each(['/login', '/contact/verify?token=secret', '/?%74OKEN=secret'])('a document starting on or visiting %s never reactivates', async (path) => {
	navigate(path); const startedPrivate = client(); await view(startedPrivate); navigate('/'); await view(startedPrivate); expect(requests).toEqual([]);
	const startedPublic = client(); await view(startedPublic); navigate(path); await view(startedPublic); navigate('/pricing'); await view(startedPublic); expect(sent()).toHaveLength(1);
});
test('a private same-origin referrer suppresses the entire document', async () => {
	referrer = 'https://moderaty.example/consent?state=secret'; await view(client()); expect(requests).toEqual([]);
});
test.each([false, true])('late configuration never starts collection after private navigation (cancelled: %s)', async (cancelled) => {
	const signal = new AbortController();
	vi.stubGlobal('fetch', vi.fn(async () => { navigate('/login'); if (cancelled) signal.abort(); return Response.json(config); }));
	expect(await client().pageview(new URL('https://moderaty.example/'), signal.signal)).toBe('skipped'); expect(fetch).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
});
test.each([{}, [], false, { ...config, websiteId: 'not-uuid' }, { ...config, hostname: 'moderaty.example.' }, { ...config, hostname: 'a'.repeat(101) },
	{ ...config, umamiUrl: 'http://collector.example' }, { ...config, umamiUrl: 'https://user:password@collector.example' },
	{ ...config, umamiUrl: 'https://collector.example/private' }, { ...config, umamiUrl: 'https://collector.example/?token=secret' }])('malformed configuration cannot contact a collector: %j', async (body) => {
	configBody = body; await expect(view(client())).rejects.toThrow('Optional usage measurement is unavailable.'); expect(sent()).toEqual([]); expect(failure).toHaveBeenCalled(); expect(logs()).not.toContain('password');
});
test.each(['http', 'network', 'json'])('configuration %s failures remain generic', async (mode) => {
	vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
		if (options.method === 'POST') return new Response(null, { status: 204 });
		if (mode === 'network') throw new Error('token=private');
		return mode === 'http' ? new Response('private', { status: 503 }) : new Response('private');
	}));
	await expect(view(client())).rejects.toThrow('Optional usage measurement is unavailable.'); expect(failure).toHaveBeenCalled(); expect(logs()).not.toContain('private');
});
test('uses only bounded in-memory cache and clears it when runtime configuration changes', async () => {
	const instance = client(); await view(instance); navigate('/pricing'); await view(instance);
	expect(sent()[1].options.headers).toEqual({ 'content-type': 'application/json', 'x-umami-cache': 'memory-token' });
	configBody = { ...config, websiteId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }; navigate('/privacy'); await view(instance);
	expect(sent()[2].options.headers).toEqual({ 'content-type': 'application/json' }); expect((sent()[2].body?.payload as { website: string }).website).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
});
test('bot suppression is a deliberate skip', async () => {
	collector = async () => Response.json({ beep: 'boop' }); expect(await view(client())).toBe('skipped'); expect(failure).not.toHaveBeenCalled();
});
test.each([{}, [], { cache: '' }, { cache: 'x'.repeat(4097) }, { cache: 12 }, { sessionId: 'not-a-cache' }])('malformed collector success rejects without retry: %j', async (body) => {
	collector = async () => Response.json(body); const instance = client(); await expect(view(instance)).rejects.toThrow('Optional usage measurement is unavailable.');
	expect(await view(instance)).toBe('skipped'); expect(sent()).toHaveLength(1); expect(failure).toHaveBeenCalled();
});
test.each(['http', 'network', 'json'])('collector %s failure sends a payload-free diagnostic', async (mode) => {
	collector = async () => {
		if (mode === 'network') throw new Error('cache=secret');
		return mode === 'http' ? new Response('cache=secret', { status: 500 }) : new Response('cache=secret');
	};
	await expect(view(client())).rejects.toThrow('Optional usage measurement is unavailable.');
	expect(requests.filter((request) => request.url.includes('/api/analytics') && request.options.method === 'POST')).toEqual([
		{ url: 'https://moderaty.example/api/analytics?hostname=moderaty.example', options: { method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: expect.any(AbortSignal) } }
	]);
	expect(logs()).not.toContain('secret');
});
test('a connect click freezes the public payload and its request survives login navigation and stop', async () => {
	const instance = client(); await view(instance); let finish!: (response: Response) => void;
	collector = () => new Promise((resolve) => { finish = resolve; }); const click = instance.click('connect_click', 'hero');
	navigate('/login?state=secret'); instance.stop(); expect(sent()).toHaveLength(2);
	expect(sent()[1].body).toEqual({ type: 'event', payload: expectedPayload('/', 'Home', { name: 'connect_click', data: { placement: 'hero' } }) });
	expect(sent()[1].options.keepalive).toBe(true); expect(sent()[1].options.signal?.aborted).toBe(false);
	finish(Response.json({ cache: 'late-token' })); expect(await click).toBe('sent'); navigate('/');
	expect(await view(instance)).toBe('skipped'); expect(await instance.click('connect_click', 'hero')).toBe('skipped'); expect(sent()).toHaveLength(2);
});
test('stop aborts pending configuration and permanently prevents revival', async () => {
	let finish!: (response: Response) => void; let requestSignal: AbortSignal | undefined;
	vi.stubGlobal('fetch', vi.fn((_url, options) => { requestSignal = options.signal; return new Promise((resolve) => { finish = resolve; }); }));
	const instance = client(); const pending = view(instance); instance.stop(); expect(requestSignal?.aborted).toBe(true);
	finish(Response.json(config)); expect(await pending).toBe('skipped'); expect(await view(instance)).toBe('skipped'); expect(failure).not.toHaveBeenCalled();
});
test('validates event pairs even when the caller bypasses TypeScript', async () => {
	const instance = client(); await view(instance); expect(await instance.click('connect_click', 'footer')).toBe('skipped');
	expect(await instance.click('email=secret' as never, 'hero')).toBe('skipped'); expect(sent()).toHaveLength(1);
});

test.each(['dnt', 'gpc', 'stored'])('%s preference prevents configuration and collector requests', async (preference) => {
	if (preference === 'dnt') vi.stubGlobal('navigator', { doNotTrack: '1' });
	if (preference === 'gpc') vi.stubGlobal('navigator', { globalPrivacyControl: true });
	if (preference === 'stored') browser.localStorage.setItem('moderaty.analytics.optOut', '1');
	const instance = client(); expect(await view(instance)).toBe('skipped'); expect(await instance.click('connect_click', 'hero')).toBe('skipped'); expect(requests).toEqual([]);
});
test('storage read failure remains disabled and reports a generic visible failure', async () => {
	browser.localStorage.getItem = () => { throw new Error('private storage details'); };
	const instance = client(); expect(await view(instance)).toBe('skipped'); expect(requests).toEqual([]); expect(failure).toHaveBeenCalled(); expect(logs()).not.toContain('private');
});
test('storage write failure blocks an already active client', async () => {
	const instance = client(); await view(instance);
	browser.localStorage.setItem = () => { throw new Error('private storage details'); };
	expect(() => setAnalyticsOptOut(true)).toThrow('Audience measurement preference is unavailable.');
	navigate('/pricing'); expect(await view(instance)).toBe('skipped'); expect(sent()).toHaveLength(1);
});
test('preference stores only the opt-out key and broadcasts successful same-tab changes', () => {
	expect(getAnalyticsOptOut()).toBe(false); setAnalyticsOptOut(true); expect(getAnalyticsOptOut()).toBe(true);
	expect(browser.localStorage.getItem('moderaty.analytics.optOut')).toBe('1');
	setAnalyticsOptOut(false); expect(getAnalyticsOptOut()).toBe(false); expect(browser.localStorage.getItem('moderaty.analytics.optOut')).toBeNull();
	expect(browser.dispatchEvent).toHaveBeenCalledTimes(2);
});
test('opt-out during pending configuration prevents a send and later opt-in cannot revive the document', async () => {
	let finish!: (response: Response) => void;
	vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { finish = resolve; })));
	const instance = client(); const loading = view(instance); setAnalyticsOptOut(true); finish(Response.json(config));
	expect(await loading).toBe('skipped'); setAnalyticsOptOut(false); navigate('/pricing'); expect(await view(instance)).toBe('skipped'); expect(fetch).toHaveBeenCalledOnce();
});
test('a late old-configuration response cannot replace the new-configuration cache', async () => {
	const instance = client(); await view(instance);
	let finish!: (response: Response) => void;
	collector = () => new Promise((resolve) => { finish = resolve; }); const click = instance.click('connect_click', 'hero');
	collector = async () => Response.json({ cache: 'new-config-token' });
	configBody = { ...config, websiteId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }; navigate('/pricing'); await view(instance);
	finish(Response.json({ cache: 'old-config-token' })); await click; navigate('/privacy'); await view(instance);
	expect(sent().at(-1)?.options.headers).toEqual({ 'content-type': 'application/json', 'x-umami-cache': 'new-config-token' });
});
test.each([['click', 0], ['auxclick', 1]])('nested %s activation uses only the approved marker pair', (type, button) => {
	class Marker {
		closest(selector: string) { expect(selector).toBe('a[data-moderaty-event][data-moderaty-placement]'); return this; }
		getAttribute(name: string) { return name === 'data-moderaty-event' ? 'connect_click' : 'hero'; }
		get textContent() { throw new Error('DOM text must not be read'); }
		get href() { throw new Error('Destination must not be read'); }
	}
	vi.stubGlobal('Element', Marker);
	const event = { type, button, target: new Marker(), ctrlKey: true, metaKey: true, detail: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() };
	expect(readMarketingClick(event as unknown as MouseEvent)).toEqual({ name: 'connect_click', placement: 'hero' });
	expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
});
test.each([['click', 1], ['auxclick', 0], ['auxclick', 2], ['contextmenu', 2]])('ignores %s button %s', (type, button) => {
	expect(readMarketingClick({ type, button, target: null } as unknown as MouseEvent)).toBeNull();
});
