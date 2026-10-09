import { beforeEach, expect, test, vi } from 'vitest';
import { error } from '@sveltejs/kit';
import { DrizzleQueryError } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	getSessionUser: vi.fn(),
	assertMigrationsCurrent: vi.fn(),
	cookieSecure: vi.fn(() => false)
}));

vi.mock('$lib/server/session', () => ({
	SESSION_COOKIE: 'moderaty_session',
	getSessionUser: mocks.getSessionUser
}));

vi.mock('$lib/server/oauthState', () => ({
	cookieSecure: mocks.cookieSecure
}));

vi.mock('$lib/server/migrationGuard', () => ({
	assertMigrationsCurrent: mocks.assertMigrationsCurrent
}));

import { LOCALE_COOKIE } from '$lib/i18n/locale';
import { handle, handleError } from './hooks.server';

beforeEach(() => {
	// Drop lingering console.error spies so per-test call assertions are clean.
	vi.restoreAllMocks();
	mocks.getSessionUser.mockReset();
	mocks.assertMigrationsCurrent.mockReset().mockResolvedValue(undefined);
	mocks.cookieSecure.mockReset().mockReturnValue(false);
});

function makeEvent() {
	return {
		cookies: { get: () => 'session-token', set: vi.fn() },
		locals: {} as { user: unknown; dbDown?: boolean },
		url: new URL('http://localhost/'),
		route: { id: '/' }
	};
}

test.each(['/blogs', '/blogs/how-to-deal-with-hate-comments-on-youtube', '/blogs/how-to-stop-spam-and-scam-comments-on-youtube'])(
	'public blog %s stays available without database migrations or a valid session',
	async (routeId) => {
		mocks.assertMigrationsCurrent.mockImplementation(async () => error(503, 'Migrations pending'));
		mocks.getSessionUser.mockImplementation(async () => error(500, 'Session integrity failure'));
		const event = {
			...makeEvent(),
			route: { id: routeId },
			url: new URL(`https://preview.example${routeId}/`)
		};
		const response = Promise.resolve(handle({
			event,
			resolve: async (_event: unknown, opts?: { transformPageChunk?: (input: { html: string; done: boolean }) => string }) =>
				new Response(opts?.transformPageChunk?.({ html: '<html lang="en"><body>Public article</body></html>', done: true }))
		} as never));
		await expect(response.then((value) => value.text())).resolves.toBe('<html lang="en"><body>Public article</body></html>');
		expect((await response).headers.get('x-robots-tag')).toBeNull();
		expect(mocks.assertMigrationsCurrent).not.toHaveBeenCalled();
		expect(mocks.getSessionUser).not.toHaveBeenCalled();
	}
);

test('analytics configuration remains available without the database or session and stays noindex', async () => {
	mocks.assertMigrationsCurrent.mockRejectedValue(new Error('database unavailable'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mocks.getSessionUser.mockRejectedValue(new Error('database unavailable'));
	const event = { ...makeEvent(), route: { id: '/api/analytics' } };
	const response = await handle({ event, resolve: async () => new Response('null') } as never);
	expect(await response.text()).toBe('null');
	expect(response.headers.get('x-robots-tag')).toBe('noindex');
	expect(mocks.assertMigrationsCurrent).not.toHaveBeenCalled();
	expect(mocks.getSessionUser).not.toHaveBeenCalled();
});

test('the locale is read from the exported LOCALE_COOKIE and applied to the html lang', async () => {
	// The cookie name must come from $lib/i18n/locale's LOCALE_COOKIE, not a
	// hardcoded string that can drift from the writer in /api/locale (cubic).
	mocks.getSessionUser.mockResolvedValue(null);
	const event = {
		cookies: { get: (name: string) => (name === LOCALE_COOKIE ? 'pt-BR' : undefined), set: vi.fn() },
		locals: {} as { user: unknown; dbDown?: boolean },
		url: new URL('http://localhost/login'),
		route: { id: '/login' }
	};
	const resolve = vi.fn(
		async (_event: unknown, opts?: { transformPageChunk?: (input: { html: string; done: boolean }) => string }) =>
			new Response(opts?.transformPageChunk?.({ html: '<html lang="en"><body></body></html>', done: true }))
	);

	const response = await handle({ event, resolve } as never);

	expect(await response.text()).toContain('<html lang="pt-BR">');
});

test('a pt-BR cookie cannot mark an English-only surface pt-BR (MOD-11)', async () => {
	// The html lang must describe the actual content: on the English-only app
	// surface a stored pt-BR preference would otherwise claim a translation
	// that does not exist.
	mocks.getSessionUser.mockResolvedValue(null);
	const event = {
		cookies: { get: (name: string) => (name === LOCALE_COOKIE ? 'pt-BR' : undefined), set: vi.fn() },
		locals: {} as { user: unknown; dbDown?: boolean },
		url: new URL('http://localhost/dashboard'),
		route: { id: '/(app)/dashboard' }
	};
	const resolve = vi.fn(
		async (_event: unknown, opts?: { transformPageChunk?: (input: { html: string; done: boolean }) => string }) =>
			new Response(opts?.transformPageChunk?.({ html: '<html lang="en"><body></body></html>', done: true }))
	);

	const response = await handle({ event, resolve } as never);

	expect(await response.text()).toContain('<html lang="en">');
});

test('a database failure during session lookup degrades to maintenance mode, never a bare 500', async () => {
	mocks.getSessionUser.mockRejectedValue(new Error('database is locked'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(event.locals.user).toBeNull();
	expect(event.locals.dbDown).toBe(true);
	// Loud on the server even though the user gets a maintenance page.
	expect(console.error).toHaveBeenCalled();
});

test.each([new Error('SQLITE_UNKNOWN: S3 storage returned HTTP 500'), undefined])('session query failures log a safe category without the provider cause or cookie token: %s', async (cause) => {
	const token = 'synthetic-session-cookie';
	mocks.getSessionUser.mockRejectedValue(new DrizzleQueryError('select * from sessions where id = ?', [token], cause));
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = { ...makeEvent(), cookies: { get: () => token, set: vi.fn() } };

	await handle({ event, resolve: async () => new Response('maintenance') } as never);

	expect(mocks.getSessionUser).toHaveBeenCalledWith(token);
	expect(event.locals.dbDown).toBe(true);
	expect(event.locals.user).toBeNull();
	expect(event.cookies.set).not.toHaveBeenCalled();
	expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ type: 'session_lookup_failed', severity: 'error', category: 'database', route: '/' });
	if (cause) expect(JSON.stringify(log.mock.calls)).not.toContain(cause.message);
	expect(JSON.stringify(log.mock.calls)).not.toContain(token);
});

test('a resolved session user populates locals.user', async () => {
	mocks.getSessionUser.mockResolvedValue({
		user: { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' },
		renewed: false,
		expiresAt: '2026-08-01T00:00:00.000Z'
	});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(event.locals.user).toMatchObject({ id: 'user-1' });
});

test('a renewed session refreshes the cookie with the new expiry and security attributes', async () => {
	// Mutation audit: deleting the whole renewal branch stayed green — renewed
	// in the DB but stale in the browser logs active users out at the original
	// expiry. Attribute flips (httpOnly/sameSite) were equally invisible, and
	// hard-coding `secure` instead of calling cookieSecure() passed too — so
	// the test also asserts the helper is consulted.
	mocks.cookieSecure.mockReturnValue(true);
	mocks.getSessionUser.mockResolvedValue({
		user: { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' },
		renewed: true,
		expiresAt: '2026-09-01T00:00:00.000Z'
	});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(mocks.cookieSecure).toHaveBeenCalled();
	expect(event.cookies.set).toHaveBeenCalledWith('moderaty_session', 'session-token', {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: true,
		expires: new Date('2026-09-01T00:00:00.000Z')
	});
});

test('a database behind the code fails an internal route with the guard 503 before any session work', async () => {
	// error() throws by design — capture the HttpError it produces so the mock
	// rejects with the same instanceof the real guard throws.
	let guardError: unknown;
	try {
		error(503, 'the service is being upgraded — please retry in a few minutes');
	} catch (e) {
		guardError = e;
	}
	mocks.assertMigrationsCurrent.mockRejectedValue(guardError);
	const event = {
		...makeEvent(),
		url: new URL('http://localhost/dashboard'),
		route: { id: '/(app)/dashboard' }
	};
	const resolve = vi.fn(async () => new Response('ok'));

	expect((await handle({ event, resolve } as never)).status).toBe(503);
	expect(mocks.getSessionUser).not.toHaveBeenCalled();
	expect(resolve).not.toHaveBeenCalled();
});

test('a database failure inside the guard check degrades to maintenance mode, never a bare 500', async () => {
	mocks.assertMigrationsCurrent.mockRejectedValue(new Error('database is locked'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	// The session lookup is skipped — it would fail the same way.
	expect(mocks.getSessionUser).not.toHaveBeenCalled();
	expect(event.locals.user).toBeNull();
	expect(event.locals.dbDown).toBe(true);
	expect(console.error).toHaveBeenCalled();
});

test('/login still renders during a database outage (signed-out view, maintenance flagged)', async () => {
	mocks.getSessionUser.mockRejectedValue(new Error('database is locked'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = { ...makeEvent(), url: new URL('http://localhost/login'), route: { id: '/login' } };
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(event.locals.user).toBeNull();
	expect(event.locals.dbDown).toBe(true);
});

test('/api/health bypasses the guard and session so a database outage still reaches the probe', async () => {
	// The probe's whole job is to report database health itself (issue #82):
	// the guard or the session lookup would convert an outage into a 500
	// before the endpoint could answer with its documented 503.
	mocks.assertMigrationsCurrent.mockRejectedValue(new Error('database is locked'));
	const event = { ...makeEvent(), url: new URL('http://localhost/api/health'), route: { id: '/api/health' } };
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(mocks.assertMigrationsCurrent).not.toHaveBeenCalled();
	expect(mocks.getSessionUser).not.toHaveBeenCalled();
});

test.each([
	['/robots.txt', '/robots.txt', 'User-agent: *'],
	['/sitemap.xml', '/sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>'],
	['/llms.txt', '/llms.txt', '# Moderaty']
])('%s bypasses the migration guard and session lookup', async (routeId, pathname, content) => {
	let guardError: unknown;
	try {
		error(503, 'the service is being upgraded — please retry in a few minutes');
	} catch (e) {
		guardError = e;
	}
	mocks.assertMigrationsCurrent.mockRejectedValue(guardError);
	mocks.getSessionUser.mockRejectedValue(new Error('session lookup should not run'));
	const event = { ...makeEvent(), url: new URL(`http://localhost${pathname}`), route: { id: routeId } };
	const resolve = vi.fn(async () => new Response(content));

	const response = await handle({ event, resolve } as never);

	expect(response.status).toBe(200);
	expect(await response.text()).toBe(content);
	expect(mocks.assertMigrationsCurrent).not.toHaveBeenCalled();
	expect(mocks.getSessionUser).not.toHaveBeenCalled();
	expect(response.headers.get('x-robots-tag')).toBeNull();
});

test('a deliberate HttpError from session resolution propagates — integrity failures are not outages', async () => {
	// getSessionUser throws error(500) for data-integrity failures (an account
	// with no organization). Degrading those to maintenance would mask
	// corruption as an outage and sign the user out; they must fail loudly.
	let integrity: unknown;
	try {
		error(500, 'account has no organization — contact support');
	} catch (e) {
		integrity = e;
	}
	mocks.getSessionUser.mockRejectedValue(integrity);
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	expect((await handle({ event, resolve } as never)).status).toBe(500);
	expect(event.locals.dbDown).toBeUndefined();
	expect(resolve).not.toHaveBeenCalled();
});

test('no session resolves to signed-out without tripping the maintenance flag', async () => {
	// Mutation audit: dropping the optional chaining on `resolution?.user` /
	// `resolution?.renewed` turns a signed-out visitor into a TypeError that
	// the catch swallows as dbDown — every signed-out page would render the
	// maintenance overlay. Assert dbDown stays unset for the null resolution.
	mocks.getSessionUser.mockResolvedValue(null);
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(event.locals.user).toBeNull();
	expect(event.locals.dbDown).toBeUndefined();
	expect(errSpy).not.toHaveBeenCalled();
	expect(event.cookies.set).not.toHaveBeenCalled();
});

test('a non-renewed session does not rewrite the cookie', async () => {
	// Mutation audit: forcing the renewal condition true (or swapping && for
	// ||) re-sets the cookie on every request — harmless-looking but it
	// defeats the renewal-window design and hides real expiry behavior.
	mocks.getSessionUser.mockResolvedValue({
		user: { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' },
		renewed: false,
		expiresAt: '2026-08-01T00:00:00.000Z'
	});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(event.cookies.set).not.toHaveBeenCalled();
});

test('a renewed session without a cookie token does not rewrite the cookie', async () => {
	// The renewal branch must also require a token to write back — without a
	// cookie there is nothing to refresh.
	mocks.getSessionUser.mockResolvedValue({
		user: { id: 'user-1', email: 'one@example.com', displayName: 'One', plan: 'free' },
		renewed: true,
		expiresAt: '2026-09-01T00:00:00.000Z'
	});
	const event = {
		cookies: { get: () => undefined, set: vi.fn() },
		locals: {} as { user: unknown; dbDown?: boolean },
		url: new URL('http://localhost/'),
		route: { id: '/' }
	};
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(resolve).toHaveBeenCalled();
	expect(event.cookies.set).not.toHaveBeenCalled();
});

test('a guard-check outage is logged with its identifiable message', async () => {
	// Mutation audit: blanking the log prefix makes ops pages ungreppable —
	// assert the exact loud message, not just that something was logged.
	mocks.assertMigrationsCurrent.mockRejectedValue(new Error('database is locked'));
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(JSON.parse(errSpy.mock.calls[0][0])).toMatchObject({ type: 'migration_check_failed', category: 'database' });
});

test('a session-lookup outage is logged with its identifiable message', async () => {
	mocks.getSessionUser.mockRejectedValue(new Error('database is locked'));
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = makeEvent();
	const resolve = vi.fn(async () => new Response('ok'));

	await handle({ event, resolve } as never);

	expect(JSON.parse(errSpy.mock.calls[0][0])).toMatchObject({ type: 'session_lookup_failed', category: 'database' });
});

test.each([
	'/(app)/dashboard',
	'/(app)/org/switch',
	'/api/cron',
	'/invite/[token]',
	'/consent',
	'/connect-channel',
	'/logout',
	'/account-deleted',
	'/contact/verify'
])('a response on internal route %s carries X-Robots-Tag: noindex', async (routeId) => {
	mocks.getSessionUser.mockResolvedValue(null);
	const event = { ...makeEvent(), route: { id: routeId } };
	const resolve = vi.fn(async () => new Response('ok'));

	const response = await handle({ event, resolve } as never);

	expect(response.headers.get('x-robots-tag')).toBe('noindex');
});

test.each(['/', '/login', '/pricing', '/contact'])(
	'a response on public route %s stays indexable — no X-Robots-Tag',
	async (routeId) => {
		mocks.getSessionUser.mockResolvedValue(null);
		const event = { ...makeEvent(), route: { id: routeId } };
		const resolve = vi.fn(async () => new Response('ok'));

		const response = await handle({ event, resolve } as never);

		expect(response.headers.get('x-robots-tag')).toBeNull();
	}
);

test('the noindex header marks auth-gate redirects, not just rendered pages', async () => {
	// The 302 an anonymous crawler gets from /dashboard is the ONLY response
	// that URL ever produces — if the header skipped redirects, the internal
	// surface would be unmarked exactly where crawlers reach it.
	mocks.getSessionUser.mockResolvedValue(null);
	const event = {
		...makeEvent(),
		url: new URL('http://localhost/dashboard'),
		route: { id: '/(app)/dashboard' }
	};
	const resolve = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/login' } }));

	const response = await handle({ event, resolve } as never);

	expect(response.status).toBe(302);
	expect(response.headers.get('x-robots-tag')).toBe('noindex');
});

function abortedRequestEvent(aborted: boolean) {
	const controller = new AbortController();
	if (aborted) controller.abort();
	return {
		request: new Request('http://localhost/channels/UC1/feedback', { method: 'POST', signal: controller.signal }),
		url: new URL('http://localhost/channels/UC1/feedback'),
		route: { id: '/(app)/channels/[id]/feedback' }
	};
}

test('a client that disconnects mid-request logs a warn line, not a fake 500', async () => {
	// 2026-10-01 dev log: a socket close during a form POST surfaced as
	// `[500] POST /channels/…/feedback — Error: aborted` via the default
	// handleError. A gone client is not a server defect — demote it so real
	// 500s stay greppable.
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const err = vi.spyOn(console, 'error').mockImplementation(() => {});

	const result = await handleError({
		error: new Error('aborted'),
		event: abortedRequestEvent(true) as never,
		status: 500,
		message: 'Internal Error'
	});

	expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({ type: 'request_disconnected', severity: 'warn', category: 'client_disconnect', route: '/(app)/channels/[id]/feedback' });
	expect(err).not.toHaveBeenCalled();
	expect(result).toEqual({ message: 'Internal Error' });
});

test('a real unexpected error emits a loud safe category instead of the raw stack', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const err = vi.spyOn(console, 'error').mockImplementation(() => {});
	const boom = new TypeError('db exploded');

	const result = await handleError({
		error: boom,
		event: abortedRequestEvent(false) as never,
		status: 500,
		message: 'Internal Error'
	});

	expect(JSON.parse(err.mock.calls[0][0])).toMatchObject({ type: 'unexpected_server_error', severity: 'error', category: 'unexpected', route: '/(app)/channels/[id]/feedback' });
	expect(JSON.parse(err.mock.calls[0][0])).toMatchObject({ errorKind: 'TypeError', errorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
	expect(JSON.stringify(err.mock.calls)).not.toContain(boom.message);
	expect(warn).not.toHaveBeenCalled();
	expect(result).toEqual({ message: 'Internal Error' });
});

test('a framework 404 logs a short warn line, not an error with a stack', async () => {
	// Unmatched routes and missing data requests reach handleError as
	// SvelteKitError(status 404) — scanner hits like /wp-admin would print a
	// stack on the error channel every time (gitar). The default logger prints
	// only the request line for them; the override must not regress that.
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const err = vi.spyOn(console, 'error').mockImplementation(() => {});

	const result = await handleError({
		error: new Error('Not found: /wp-admin'),
		event: abortedRequestEvent(false) as never,
		status: 404,
		message: 'Not Found'
	});

	expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({ type: 'request_not_found', severity: 'warn', category: 'not_found' });
	expect(err).not.toHaveBeenCalled();
	expect(result).toEqual({ message: 'Not Found' });
});

test('an abort-shaped error on a live connection still logs as a 500', async () => {
	// The request-signal guard distinguishes a client disconnect from an
	// abort raised by our own code (e.g. a fetch timeout inside an action) —
	// only a dead request demotes.
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const err = vi.spyOn(console, 'error').mockImplementation(() => {});

	await handleError({
		error: new Error('aborted'),
		event: abortedRequestEvent(false) as never,
		status: 500,
		message: 'Internal Error'
	});

	expect(err).toHaveBeenCalled();
	expect(warn).not.toHaveBeenCalled();
});

test('the /api/health early return also carries the noindex header', async () => {
	// Health bypasses resolveLocalized via plain resolve() — the wrapping
	// must happen on that path too or the probe endpoint stays unmarked.
	const event = {
		...makeEvent(),
		url: new URL('http://localhost/api/health'),
		route: { id: '/api/health' }
	};
	const resolve = vi.fn(async () => new Response('{"status":"ok"}'));

	const response = await handle({ event, resolve } as never);

	expect(response.headers.get('x-robots-tag')).toBe('noindex');
});

test.each(['/', '/api/health', '/(app)/dashboard'])('server correlation reaches %s response and locals before checks', async (routeId) => {
	const event = { ...makeEvent(), route: { id: routeId }, request: new Request('http://localhost/?token=synthetic-private-value', { headers: { 'X-Request-ID': 'client-controlled-secret' } }) };
	const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
	mocks.assertMigrationsCurrent.mockImplementation(async () => {
		expect((event.locals as Record<string, unknown>).requestId).toMatch(/^[0-9a-f-]{36}$/);
	});
	mocks.getSessionUser.mockResolvedValue(null);
	const resolve = vi.fn(async (resolvedEvent) => {
		expect(resolvedEvent.locals.requestId).toMatch(/^[0-9a-f-]{36}$/);
		return new Response('original response', { status: routeId === '/api/health' ? 503 : 200 });
	});
	const response = await handle({ event, resolve } as never);
	expect(await response.text()).toBe('original response');
	expect(response.status).toBe(routeId === '/api/health' ? 503 : 200);
	expect(response.headers.get('x-request-id')).toBe((event.locals as Record<string, unknown>).requestId);
	expect(response.headers.get('x-request-id')).not.toBe('client-controlled-secret');
	expect(errorLog).not.toHaveBeenCalled();
});

test.each(['migration', 'session'])('%s outage uses a safe event with the response correlation and unchanged maintenance outcome', async (boundary) => {
	const secret = 'synthetic-private-value';
	const cause = new DrizzleQueryError('select * from sessions where token=?', [secret], new Error('https://private.invalid/?token=' + secret + ' person@example.invalid comment-body payment-data'));
	(boundary === 'migration' ? mocks.assertMigrationsCurrent : mocks.getSessionUser).mockRejectedValue(cause);
	const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = { ...makeEvent(), route: { id: '/(app)/channels/[id]' }, url: new URL('http://localhost/channels/private-id?token=' + secret) };
	const response = await handle({ event, resolve: async () => new Response('maintenance', { status: 200 }) } as never);
	expect(await response.text()).toBe('maintenance');
	expect(event.locals.dbDown).toBe(true);
	expect(event.locals.user).toBeNull();
	expect(response.headers.get('x-robots-tag')).toBe('noindex');
	const logged = JSON.stringify(errorLog.mock.calls);
	for (const sample of [secret, 'person@example.invalid', 'comment-body', 'payment-data', 'private-id', 'select *']) expect(logged).not.toContain(sample);
	expect(JSON.parse(errorLog.mock.calls[0][0])).toMatchObject({ requestId: response.headers.get('x-request-id'), route: '/(app)/channels/[id]', category: 'database', severity: 'error' });
});

test('broken logging sinks preserve a maintenance response', async () => {
	mocks.getSessionUser.mockRejectedValue(new Error('synthetic-private-value'));
	vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('sink failed'); });
	const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
	const event = makeEvent();
	const response = await handle({ event, resolve: async () => new Response('maintenance') } as never);
	expect(await response.text()).toBe('maintenance');
	expect(event.locals.dbDown).toBe(true);
	expect(stderr).toHaveBeenCalledWith('operational logging failed\n');
});

test.each([['migration', 503], ['session', 500]])('deliberate %s failures retain status, safe message, noindex and request header', async (boundary, status) => {
	const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
	let failure;
	try { error(status as number, 'Controlled failure'); } catch (e) { failure = e; }
	(boundary === 'migration' ? mocks.assertMigrationsCurrent : mocks.getSessionUser).mockRejectedValue(failure);
	const event = { ...makeEvent(), route: { id: '/(app)/dashboard' }, request: new Request('http://localhost/dashboard', { headers: { accept: 'application/json' } }) };
	const resolve = vi.fn();
	const response = await handle({ event, resolve } as never);
	expect(response.status).toBe(status);
	expect(await response.json()).toEqual({ message: 'Controlled failure' });
	expect(response.headers.get('x-request-id')).toBe((event.locals as Record<string, unknown>).requestId);
	expect(response.headers.get('x-robots-tag')).toBe('noindex');
	expect(event.locals.dbDown).toBeUndefined();
	expect(resolve).not.toHaveBeenCalled();
	expect(errorLog).toHaveBeenCalledTimes(1);
	expect(JSON.parse(errorLog.mock.calls[0][0])).toMatchObject({
		type: boundary === 'migration' ? 'migration_check_failed' : 'session_lookup_failed',
		severity: 'error', category: boundary === 'migration' ? 'deployment' : 'integrity', route: '/(app)/dashboard',
		requestId: response.headers.get('x-request-id')
	});
	expect(JSON.stringify(errorLog.mock.calls)).not.toContain('Controlled failure');
});

test('concurrent requests get distinct server IDs and leave authentication redirects intact', async () => {
	mocks.getSessionUser.mockResolvedValue(null);
	const responses = await Promise.all(Array.from({ length: 8 }, () => handle({ event: { ...makeEvent(), route: { id: '/(app)/dashboard' } }, resolve: async () => new Response(null, { status: 302, headers: { location: '/login' } }) } as never)));
	expect(new Set(responses.map((r) => r.headers.get('x-request-id'))).size).toBe(8);
	for (const response of responses) {
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/login');
		expect(response.headers.get('x-robots-tag')).toBe('noindex');
	}
});

test('unexpected resolve errors retain a generic outcome and correlated event even with hostile error metadata', async () => {
	const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
	const hostile = Object.defineProperty({}, 'message', { get() { throw new Error('synthetic-private-value'); } });
	const event = { ...makeEvent(), request: new Request('http://localhost/?token=synthetic-private-value', { headers: { accept: 'application/json' } }) };
	const response = await handle({ event, resolve: async () => { throw hostile; } } as never);
	expect(response.status).toBe(500);
	expect(await response.json()).toEqual({ message: 'Internal Error' });
	expect(JSON.parse(errorLog.mock.calls[0][0])).toMatchObject({ requestId: response.headers.get('x-request-id'), type: 'unexpected_server_error', category: 'unexpected' });
	expect(JSON.stringify(errorLog.mock.calls)).not.toContain('synthetic-private-value');
});

test.each(['/login', '/account-deleted'])('English fallback errors on %s keep English language and escape messages', async (path) => {
	let failure;
	try { error(503, '<script>synthetic-private-value</script>'); } catch (e) { failure = e; }
	mocks.assertMigrationsCurrent.mockRejectedValue(failure);
	const event = { ...makeEvent(), route: { id: path }, url: new URL('http://localhost' + path), cookies: { get: () => 'pt-BR', set: vi.fn() }, request: new Request('http://localhost' + path) };
	const response = await handle({ event, resolve: vi.fn() } as never);
	const html = await response.text();
	expect(response.status).toBe(503);
	expect(html).toContain('<html lang="en">');
	expect(html).toContain('&lt;script&gt;synthetic-private-value&lt;/script&gt;');
	expect(html).not.toContain('<script>');
	expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
	expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
});

test('immutable redirect headers and existing cookies survive correlation', async () => {
	mocks.getSessionUser.mockResolvedValue(null);
	const redirected = await handle({ event: makeEvent(), resolve: async () => Response.redirect('http://localhost/login', 302) } as never);
	expect(redirected.status).toBe(302);
	expect(redirected.headers.get('location')).toBe('http://localhost/login');
	const response = await handle({ event: makeEvent(), resolve: async () => new Response('ok', { headers: [['set-cookie', 'one=synthetic; HttpOnly'], ['set-cookie', 'two=synthetic; HttpOnly'], ['X-Request-ID', 'client-controlled-secret']] }) } as never);
	expect(response.headers.getSetCookie()).toEqual(['one=synthetic; HttpOnly', 'two=synthetic; HttpOnly']);
	expect(response.headers.get('x-request-id')).not.toBe('client-controlled-secret');
});

test.each([
	'application/json;q=0, text/html',
	'text/html, application/json;q=0.2',
	'application/json;q=0, application/*;q=1, text/html;q=0.5',
	'application/json;q=0.2, application/*;q=1, text/html;q=0.5'
])('controlled errors honor HTML preference: %s', async (accept) => {
	let failure;
	try { error(503, 'Controlled failure'); } catch (e) { failure = e; }
	mocks.assertMigrationsCurrent.mockRejectedValue(failure);
	const event = { ...makeEvent(), request: new Request('http://localhost/', { headers: { accept } }) };
	const response = await handle({ event, resolve: vi.fn() } as never);
	expect(response.status).toBe(503);
	expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
});

test.each(['*/*', 'application/*', 'application/json;q=0.8, text/html;q=0.2', 'application/json ; q=0.8, text/html;q=0.2', 'text/html;q=0, text/*;q=1, application/json;q=0.5'])('controlled errors honor JSON preference: %s', async (accept) => {
	let failure;
	try { error(503, 'Controlled failure'); } catch (e) { failure = e; }
	mocks.assertMigrationsCurrent.mockRejectedValue(failure);
	const event = { ...makeEvent(), request: new Request('http://localhost/', { headers: { accept } }) };
	const response = await handle({ event, resolve: vi.fn() } as never);
	expect(response.status).toBe(503);
	expect(response.headers.get('content-type')).toBe('application/json');
	expect(await response.json()).toEqual({ message: 'Controlled failure' });
});

test('data requests keep controlled errors as JSON despite an HTML Accept header', async () => {
	let failure;
	try { error(503, 'Controlled failure'); } catch (e) { failure = e; }
	mocks.assertMigrationsCurrent.mockRejectedValue(failure);
	const event = { ...makeEvent(), isDataRequest: true, request: new Request('http://localhost/', { headers: { accept: 'text/html' } }) };
	const response = await handle({ event, resolve: vi.fn() } as never);
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ message: 'Controlled failure' });
	expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
});

test.each(['"same-page"', 'W/"same-page"', '*', '"other", "same-page"', 'W/"other", W/"same-page"'])('conditional responses preserve correlation and noindex: %s', async (ifNoneMatch) => {
	mocks.getSessionUser.mockResolvedValue(null);
	const event = { ...makeEvent(), route: { id: '/(app)/dashboard' }, request: new Request('http://localhost/dashboard', { headers: { 'if-none-match': ifNoneMatch } }) };
	const response = await handle({ event, resolve: async () => new Response('unchanged page', { headers: { etag: '"same-page"', 'cache-control': 'private, max-age=0', 'set-cookie': 'one=synthetic; HttpOnly', 'content-type': 'text/html' } }) } as never);
	expect(response.status).toBe(304);
	expect(await response.text()).toBe('');
	expect(response.headers.get('x-request-id')).toBe((event.locals as Record<string, unknown>).requestId);
	expect(response.headers.get('x-robots-tag')).toBe('noindex');
	expect(response.headers.get('etag')).toBe('"same-page"');
	expect(response.headers.get('cache-control')).toBe('private, max-age=0');
	expect(response.headers.get('set-cookie')).toBe('one=synthetic; HttpOnly');
	expect(response.headers.get('content-type')).toBeNull();
});

test.each(['"other"', '"same-page-extra"', '"prefix,same-page"'])('nonmatching conditional tags keep the response body: %s', async (ifNoneMatch) => {
	mocks.getSessionUser.mockResolvedValue(null);
	const event = { ...makeEvent(), request: new Request('http://localhost/', { headers: { 'if-none-match': ifNoneMatch } }) };
	const response = await handle({ event, resolve: async () => new Response('changed page', { headers: { etag: '"same-page"' } }) } as never);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('changed page');
	expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
});

test('data-request auth redirects preserve the framework redirect payload and correlation', async () => {
	mocks.getSessionUser.mockResolvedValue(null);
	const event = { ...makeEvent(), route: { id: '/(app)/dashboard' }, isDataRequest: true, request: new Request('http://localhost/dashboard', { headers: { 'if-none-match': '"old"' } }) };
	const response = await handle({ event, resolve: async () => new Response(null, { status: 302, headers: { location: '/login', 'content-type': 'text/html', 'content-length': '99', 'cache-control': 'public, max-age=3600', etag: '"old"' } }) } as never);
	expect(response.status).toBe(200);
	const payload = await response.text();
	expect(JSON.parse(payload)).toEqual({ type: 'redirect', location: '/login' });
	expect(response.headers.get('content-type')).toBe('application/json');
	expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(payload)));
	expect(response.headers.get('cache-control')).toBe('private, no-store');
	expect(response.headers.get('etag')).toBeNull();
	expect(response.headers.get('x-request-id')).toBe((event.locals as Record<string, unknown>).requestId);
	expect(response.headers.get('x-robots-tag')).toBe('noindex');
});


test.each(['migration', 'session'])('real %s outages retain safe diagnostics while degrading to maintenance', async (boundary) => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	const failure = new TypeError('synthetic-private-value');
	(boundary === 'migration' ? mocks.assertMigrationsCurrent : mocks.getSessionUser).mockRejectedValue(failure);
	const event = makeEvent();
	const response = await handle({ event, resolve: async () => new Response('maintenance') } as never);
	expect(await response.text()).toBe('maintenance');
	expect(event.locals.dbDown).toBe(true);
	expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
		type: boundary === 'migration' ? 'migration_check_failed' : 'session_lookup_failed',
		category: 'database', errorKind: 'TypeError', errorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
	});
	expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-value');
});
