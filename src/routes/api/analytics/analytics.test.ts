import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => runtime);

import { GET } from './+server';

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

function request(hostname = 'moderaty.example') {
	return GET({ url: new URL(`https://${hostname}/api/analytics`) } as never);
}

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

test.each(['moderaty.example', 'www.moderaty.example'])('an exactly allowed host gets runtime configuration: %s', async (hostname) => {
	configure();
	const response = await request(hostname);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ gtmId: 'GTM-TEST123', hostname });
	expect(response.headers.get('cache-control')).toBe('no-store');
});

test.each(['fork.example', 'dev.moderaty.example', 'moderaty.example.evil.test', 'notmoderaty.example', 'moderaty.example.'])(
	'a nonallowlisted host never receives the container ID: %s', async (hostname) => {
		configure();
		expect(await (await request(hostname)).json()).toBeNull();
		expect(console.error).not.toHaveBeenCalled();
	}
);

test('hostname configuration accepts whitespace and case without widening the allowlist', async () => {
	configure({ GTM_ALLOWED_HOSTNAMES: ' MODERATY.EXAMPLE , www.moderaty.example ' });
	expect(await (await request()).json()).toEqual({ gtmId: 'GTM-TEST123', hostname: 'moderaty.example' });
	expect(await (await request('sub.moderaty.example')).json()).toBeNull();
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
	{ GTM_ALLOWED_HOSTNAMES: '' }, { GTM_ALLOWED_HOSTNAMES: '*' },
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
