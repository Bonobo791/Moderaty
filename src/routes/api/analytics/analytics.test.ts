import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => runtime);

import * as handlers from './+server';
let fixtureMinute = 0;

beforeEach(() => {
	for (const key of Object.keys(runtime.env)) delete runtime.env[key];
	vi.spyOn(console, 'error').mockImplementation(vi.fn());
	vi.spyOn(Date, 'now').mockReturnValue(++fixtureMinute * 120_000);
});
afterEach(() => vi.restoreAllMocks());

/** Supplies enabled fixture settings; individual cases override invalid values. */
function configure(overrides: Partial<Record<string, string>> = {}) {
	Object.assign(runtime.env, {
		ANALYTICS_ENABLED: 'true',
		UMAMI_URL: 'https://collector.example', UMAMI_WEBSITE_ID: '11111111-2222-4333-8444-555555555555',
		ANALYTICS_ALLOWED_HOSTNAMES: 'moderaty.example,www.moderaty.example',
		...overrides
	});
}

/** Calls the real GET handler with a fixture host and untrusted browser claim. */
function request(hostname = 'moderaty.example', query = '') {
	const url = new URL(`https://${hostname}/api/analytics`);
	url.search = query;
	return handlers.GET({ url, request: new Request(url) } as never);
}

test.each([
	['true', 'www.moderaty.example', 204, '', [['analytics browser initialization failed']]],
	['false', 'moderaty.example', 200, 'null', []],
	['true', 'fork.example', 200, 'null', []],
	['1', 'moderaty.example', 503, '{"message":"Optional usage measurement is unavailable."}', [['analytics configuration failed:', expect.any(Error)]]]
] as const)('browser reports retain runtime/hostname gates and never log payloads: %s, %s', async (enabled, hostname, status, body, logs) => {
	configure({ ANALYTICS_ENABLED: enabled });
	expect(handlers).toHaveProperty('POST', expect.any(Function));
	const url = new URL(`https://moderaty.example/api/analytics?hostname=${hostname}`);
	const event = { url,
		request: new Request(url, { method: 'POST', body: 'token=secret&error=private-account-data' })
	} as never;
	const started = Date.now();
	for (const [elapsed, copies] of [[0, 1], [0, 1], [59_999, 1], [60_000, 2]] as const) {
		vi.mocked(Date.now).mockReturnValue(started + elapsed);
		const response = await handlers.POST(event);
		expect(response.status).toBe(status);
		expect(await response.text()).toBe(body);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(vi.mocked(console.error).mock.calls).toEqual(Array(copies).fill(logs).flat());
	}
});

test.each([
	{},
	{ ANALYTICS_ENABLED: '', UMAMI_WEBSITE_ID: 'invalid', ANALYTICS_ALLOWED_HOSTNAMES: '*' },
	{ ANALYTICS_ENABLED: 'false', UMAMI_WEBSITE_ID: 'invalid', ANALYTICS_ALLOWED_HOSTNAMES: '*' }
])('default or disabled analytics ignores leftover settings with no caching: %j', async (settings) => {
	Object.assign(runtime.env, settings);
	const response = await request();
	expect(response.status).toBe(200);
	expect(await response.json()).toBeNull();
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(console.error).not.toHaveBeenCalled();
});

const allowedHosts = 'moderaty.example,www.moderaty.example';
const primaryConfig = { umamiUrl: 'https://collector.example', websiteId: '11111111-2222-4333-8444-555555555555', hostname: 'moderaty.example' };
const aliasConfig = { umamiUrl: 'https://collector.example', websiteId: '11111111-2222-4333-8444-555555555555', hostname: 'www.moderaty.example' };

// server host, browser-host query, configured hostnames, expected public response
// Include claims separately from event.url to exercise pinned ORIGIN without trusting headers.
test.each([
	['moderaty.example', '', allowedHosts, primaryConfig],
	['www.moderaty.example', '', allowedHosts, aliasConfig],
	['fork.example', '', allowedHosts, null],
	['dev.moderaty.example', '', allowedHosts, null],
	['moderaty.example.evil.test', '', allowedHosts, null],
	['notmoderaty.example', '', allowedHosts, null],
	['moderaty.example.', '', allowedHosts, null],
	['moderaty.example', '', ' MODERATY.EXAMPLE , www.moderaty.example ', primaryConfig],
	['sub.moderaty.example', '', ' MODERATY.EXAMPLE , www.moderaty.example ', null],
	['moderaty.example', '?hostname=www.moderaty.example', allowedHosts, aliasConfig],
	['moderaty.example', '?hostname=fork.example', allowedHosts, null],
	['moderaty.example', '?hostname=moderaty.example.evil.test', allowedHosts, null],
	['moderaty.example', '?hostname=', allowedHosts, null],
	['moderaty.example', '?hostname=*.moderaty.example', allowedHosts, null],
	['moderaty.example', '?hostname=MODERATY.EXAMPLE', allowedHosts, null]
] as const)('exact hostname gates: server %s, claim %s, allowlist %s', async (hostname, query, hosts, expected) => {
	configure({ ANALYTICS_ALLOWED_HOSTNAMES: hosts });
	const response = await request(hostname, query);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(expected);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(console.error).not.toHaveBeenCalled();
});

test('configuration is read on each request rather than captured at import or build time', async () => {
	expect(await (await request()).json()).toBeNull();
	configure();
	expect(await (await request()).json()).toEqual({ umamiUrl: 'https://collector.example', websiteId: '11111111-2222-4333-8444-555555555555', hostname: 'moderaty.example' });
	runtime.env.UMAMI_WEBSITE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
	expect(await (await request()).json()).toEqual({ umamiUrl: 'https://collector.example', websiteId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', hostname: 'moderaty.example' });
	runtime.env.ANALYTICS_ENABLED = 'false';
	expect(await (await request()).json()).toBeNull();
});

test.each([
	{ ANALYTICS_ENABLED: '1' }, { ANALYTICS_ENABLED: 'TRUE' },
	{ UMAMI_URL: undefined }, { UMAMI_WEBSITE_ID: undefined }, { ANALYTICS_ALLOWED_HOSTNAMES: undefined },
	{ UMAMI_URL: '' }, { UMAMI_URL: 'http://collector.example' }, { UMAMI_URL: 'https://user:secret@collector.example' },
	{ UMAMI_URL: 'https://collector.example/path' }, { UMAMI_URL: 'https://collector.example/?token=secret' },
	{ UMAMI_URL: 'https://collector.example/#fragment' }, { UMAMI_URL: ' https://collector.example' },
	{ UMAMI_WEBSITE_ID: '' }, { UMAMI_WEBSITE_ID: 'not-a-uuid' }, { UMAMI_WEBSITE_ID: '11111111-2222-4333-8444-555555555555\n' },
	{ ANALYTICS_ALLOWED_HOSTNAMES: 'a'.repeat(101) },
	{ ANALYTICS_ALLOWED_HOSTNAMES: '' }, { ANALYTICS_ALLOWED_HOSTNAMES: ',' }, { ANALYTICS_ALLOWED_HOSTNAMES: ', , ' }, { ANALYTICS_ALLOWED_HOSTNAMES: '*' },
	{ ANALYTICS_ALLOWED_HOSTNAMES: '*.moderaty.example' },
	{ ANALYTICS_ALLOWED_HOSTNAMES: 'https://moderaty.example' },
	{ ANALYTICS_ALLOWED_HOSTNAMES: 'moderaty.example:3000' },
	{ ANALYTICS_ALLOWED_HOSTNAMES: 'moderaty.example/path' },
	{ ANALYTICS_ALLOWED_HOSTNAMES: 'moderaty.example,' },
	{ ANALYTICS_ALLOWED_HOSTNAMES: '-moderaty.example' }
])('invalid enabled configuration fails closed with a logged generic response: %j', async (overrides) => {
	configure(overrides);
	const response = await request();
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ message: 'Optional usage measurement is unavailable.' });
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(console.error).toHaveBeenCalledWith('analytics configuration failed:', expect.any(Error));
});
