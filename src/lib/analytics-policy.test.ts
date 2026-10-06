import { expect, test } from 'vitest';
import { analyticsPageUrl, buildPagePayload, isAnalyticsPage, parseMarketingClick } from './analytics-policy';

const config = { umamiUrl: 'https://collector.example', websiteId: '11111111-2222-4333-8444-555555555555', hostname: 'moderaty.example' };
const page = (path: string) => new URL(path, 'https://moderaty.example');
const payload = (url = '/', title = 'Home', referrer = '') => ({ website: config.websiteId, hostname: config.hostname, url, title, referrer });

test.each([
	['/', 'Home'], ['/pricing', 'Pricing'], ['/privacy', 'Privacy'], ['/terms', 'Terms'], ['/dpa', 'DPA'],
	['/blogs/', 'YouTube comment moderation blog'],
	['/blogs/how-to-deal-with-hate-comments-on-youtube/', 'How to deal with hate comments on YouTube']
])(
	'builds only the fixed public payload for %s', (path, title) => {
		expect(isAnalyticsPage(page(path))).toBe(true);
		expect(buildPagePayload(page(path), '', config)).toEqual(payload(path, title));
	}
);

test.each(['/login', '/consent', '/dashboard', '/contact', '/contact/verify', '/invite/secret', '/pricing/', '/blog', '/unknown',
	'/blogs', '/blogs/unreviewed/', '/blogs/how-to-deal-with-hate-comments-on-youtube'])(
	'excludes %s', (path) => {
		expect(isAnalyticsPage(page(path))).toBe(false);
		expect(buildPagePayload(page(path), '', config)).toBeNull();
	}
);

test.each(['/blogs/', '/blogs/how-to-deal-with-hate-comments-on-youtube/'])(
	'public blog %s retains credential-query and private-referrer suppression', (path) => {
		for (const query of ['token=secret', '%74OKEN=secret', 'email=secret', 'state=secret']) {
			const url = page(`${path}?${query}`);
			expect(isAnalyticsPage(url)).toBe(false);
			expect(buildPagePayload(url, '', config)).toBeNull();
		}
		expect(buildPagePayload(page(path), 'https://moderaty.example/consent?state=secret', config)).toBeNull();
	}
);

test.each(['code', 'state', 'token', 'access_token', 'refresh_token', 'id_token', 'email', 'invite', 'session', 'password', 'reset', 'verification', 'ToKeN', '%74oken', '%45MAIL'])(
	'excludes a parsed credential key %s even when its value is empty', (key) => {
		expect(isAnalyticsPage(page(`/?${key}=`))).toBe(false);
		expect(buildPagePayload(page(`/?utm_source=google&${key}=secret`), '', config)).toBeNull();
	}
);

test('drops fragments, arbitrary values and all nonapproved query parameters', () => {
	expect(buildPagePayload(page('/pricing?utm_campaign=alice-123&utm_source=alice%40example.com&utm_medium=other&gclid=secret&anything=secret#secret'), '', config))
		.toEqual(payload('/pricing', 'Pricing'));
	expect(buildPagePayload(page('/?utm_source=google&utm_medium=cpc&utm_campaign=launch&fbclid=secret#secret'), '', config))
		.toEqual(payload('/?utm_source=google&utm_medium=cpc'));
});

test.each(['google', 'youtube', 'instagram', 'facebook', 'linkedin', 'newsletter'])('allows only the approved source %s', (source) => {
	expect(buildPagePayload(page(`/?utm_source=${source}`), '', config)).toEqual(payload(`/?utm_source=${source}`));
});
test.each(['organic', 'social', 'cpc', 'email', 'referral'])('allows only the approved medium %s', (medium) => {
	expect(buildPagePayload(page(`/?utm_medium=${medium}`), '', config)).toEqual(payload(`/?utm_medium=${medium}`));
});

test.each(['utm_source=google&utm_source=google', 'utm_source=google&utm_source=secret', 'utm_medium=cpc&utm_medium=email', 'utm_campaign=launch&utm_campaign=launch', 'utm_source=Google', 'utm_source=%20google', 'utm_campaign=looks-safe'])(
	'discards duplicate or unapproved campaign data: %s', (query) => {
		expect(buildPagePayload(page(`/?${query}`), '', config)).toEqual(payload());
	}
);

test('canonicalizes UTM ordering without preserving caller query order', () => {
	expect(buildPagePayload(page('/?utm_medium=email&utm_source=newsletter&ignored=value'), '', config))
		.toEqual(payload('/?utm_source=newsletter&utm_medium=email'));
});

test('uses the same pageview identity for hash, ignored query and reordered UTM navigation', () => {
	for (const path of ['/', '/#regulars', '/?ignored=value', '/?utm_campaign=unapproved#regulars']) {
		expect(analyticsPageUrl(page(path))).toBe('/');
	}
	for (const path of ['/?utm_source=google&utm_medium=cpc', '/?utm_medium=cpc&ignored=value&utm_source=google#regulars']) {
		expect(analyticsPageUrl(page(path))).toBe('/?utm_source=google&utm_medium=cpc');
	}
	expect(analyticsPageUrl(page('/login'))).toBeNull();
	expect(analyticsPageUrl(page('/?token='))).toBeNull();
});

test.each(['https://ref.example/private?email=secret#fragment', 'https://user:password@ref.example:8443/private?token=secret'])(
	'uses only an external HTTP(S) referrer origin: %s', (referrer) => {
		expect(buildPagePayload(page('/'), referrer, config)).toEqual(payload('/', 'Home', new URL(referrer).origin));
	}
);
test.each(['', 'https://moderaty.example/pricing?utm_source=google', 'ftp://external.example/secret'])(
	'omits safe same-origin and non-HTTP referrers: %s', (referrer) => {
		expect(buildPagePayload(page('/'), referrer, config)).toEqual(payload());
	}
);
test.each(['https://moderaty.example/login', 'https://moderaty.example/privacy?%54OKEN=secret', 'https://user:secret@moderaty.example/', 'not a URL'])(
	'suppresses unsafe same-origin or invalid referrers: %s', (referrer) => {
		expect(buildPagePayload(page('/'), referrer, config)).toBeNull();
	}
);

test('rejects copied configuration and credential-bearing page URLs', () => {
	expect(buildPagePayload(new URL('https://fork.example/'), '', config)).toBeNull();
	expect(buildPagePayload(new URL('https://user:secret@moderaty.example/'), '', config)).toBeNull();
});

const pairs = {
	connect_click: ['nav', 'nav_mobile', 'hero', 'final_cta', 'plan_hosted', 'plan_lifetime'],
	pricing_click: ['nav', 'nav_mobile', 'home_pricing', 'footer'],
	source_click: ['nav', 'nav_mobile', 'footer', 'plan_self_hosted'],
	contact_click: ['footer', 'pricing_contact']
};
test('accepts exactly the documented event and placement pairs', () => {
	for (const [name, placements] of Object.entries(pairs)) {
		for (const placement of new Set(Object.values(pairs).flat())) {
			expect(parseMarketingClick(name, placement)).toEqual(placements.includes(placement) ? { name, placement } : null);
		}
	}
	for (const [name, placement] of [[null, 'nav'], ['connect_click', null], ['login', 'nav'], ['connect_click', 'NAV'], ['connect_click', 'token=secret'], ['__proto__', 'nav']]) {
		expect(parseMarketingClick(name, placement)).toBeNull();
	}
});
