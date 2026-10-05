import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => runtime);

import * as handlers from './+server';

beforeEach(() => {
	for (const key of Object.keys(runtime.env)) delete runtime.env[key];
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function configure(overrides: Partial<Record<string, string>> = {}) {
	Object.assign(runtime.env, {
		ANALYTICS_ENABLED: 'true',
		GTM_ID: 'GTM-TEST123',
		GTM_ALLOWED_HOSTNAMES: 'moderaty.example,www.moderaty.example',
		...overrides
	});
}

function request(hostname = 'moderaty.example', query = '') {
	const url = new URL(`https://${hostname}/api/analytics`);
	url.search = query;
	return handlers.GET({ url, request: new Request(url) } as never);
}

test.each([
	['true', 'www.moderaty.example', 204, '', [['analytics browser initialization failed']]],
	['false', 'moderaty.example', 200, 'null', []],
	['true', 'fork.example', 200, 'null', []]
] as const)('browser reports retain runtime/hostname gates and never log payloads: %s, %s', async (enabled, hostname, status, body, logs) => {
	configure({ ANALYTICS_ENABLED: enabled });
	expect(handlers).toHaveProperty('POST', expect.any(Function));
	const url = new URL(`https://moderaty.example/api/analytics?hostname=${hostname}`);
	const response = await handlers.POST({ url,
		request: new Request(url, { method: 'POST', body: 'token=secret&error=private-account-data' })
	} as never);
	expect(response.status).toBe(status);
	expect(await response.text()).toBe(body);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(vi.mocked(console.error).mock.calls).toEqual(logs);
});

test('an unchanged fork returns disabled configuration with no caching', async () => {
	const response = await request();
	expect(response.status).toBe(200);
	expect(await response.json()).toBeNull();
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(console.error).not.toHaveBeenCalled();
});

test.each(['', 'false'])('disabled analytics ignores even invalid leftover settings: %s', async (enabled) => {
	configure({ ANALYTICS_ENABLED: enabled, GTM_ID: 'invalid', GTM_ALLOWED_HOSTNAMES: '*' });
	expect(await (await request()).json()).toBeNull();
	expect(console.error).not.toHaveBeenCalled();
});

const allowedHosts = 'moderaty.example,www.moderaty.example';
const primaryConfig = { gtmId: 'GTM-TEST123', hostname: 'moderaty.example' };
const aliasConfig = { gtmId: 'GTM-TEST123', hostname: 'www.moderaty.example' };

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
	configure({ GTM_ALLOWED_HOSTNAMES: hosts });
	const response = await request(hostname, query);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(expected);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(console.error).not.toHaveBeenCalled();
});

test('configuration is read on each request rather than captured at import or build time', async () => {
	expect(await (await request()).json()).toBeNull();
	configure();
	expect(await (await request()).json()).toEqual({ gtmId: 'GTM-TEST123', hostname: 'moderaty.example' });
	runtime.env.GTM_ID = 'GTM-OTHER456';
	expect(await (await request()).json()).toEqual({ gtmId: 'GTM-OTHER456', hostname: 'moderaty.example' });
	runtime.env.ANALYTICS_ENABLED = 'false';
	expect(await (await request()).json()).toBeNull();
});

test.each([
	{ ANALYTICS_ENABLED: '1' }, { ANALYTICS_ENABLED: 'TRUE' },
	{ GTM_ID: '' }, { GTM_ID: 'G-TEST123' }, { GTM_ID: 'GTM-TEST123&x=1' },
	{ GTM_ID: 'GTM-<script>' }, { GTM_ID: ' GTM-TEST123' }, { GTM_ID: 'GTM-TEST123\n' },
	{ GTM_ALLOWED_HOSTNAMES: '' }, { GTM_ALLOWED_HOSTNAMES: ',' }, { GTM_ALLOWED_HOSTNAMES: ', , ' }, { GTM_ALLOWED_HOSTNAMES: '*' },
	{ GTM_ALLOWED_HOSTNAMES: '*.moderaty.example' },
	{ GTM_ALLOWED_HOSTNAMES: 'https://moderaty.example' },
	{ GTM_ALLOWED_HOSTNAMES: 'moderaty.example:3000' },
	{ GTM_ALLOWED_HOSTNAMES: 'moderaty.example/path' },
	{ GTM_ALLOWED_HOSTNAMES: 'moderaty.example,' },
	{ GTM_ALLOWED_HOSTNAMES: '-moderaty.example' }
])('invalid enabled configuration fails closed with a logged generic response: %j', async (overrides) => {
	configure(overrides);
	const response = await request();
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ message: 'Optional usage measurement is unavailable.' });
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(console.error).toHaveBeenCalledWith('analytics configuration failed:', expect.any(Error));
});

test.each(['GTM_ID', 'GTM_ALLOWED_HOSTNAMES'])('enabled analytics fails closed when %s is unset', async (key) => {
	configure();
	delete runtime.env[key];
	const response = await request();
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ message: 'Optional usage measurement is unavailable.' });
	expect(console.error).toHaveBeenCalled();
});
