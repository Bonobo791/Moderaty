import { afterEach, expect, test, vi } from 'vitest';
const configuration = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => ({ get env() { return configuration.env; } }));
import { emitOperationalEvent } from './operationalEvents';

afterEach(() => { vi.restoreAllMocks(); configuration.env = {}; });
const requestId = '11111111-1111-4111-8111-111111111111';

test('emits stable allowlisted JSON fields and validated environment/release', () => {
	configuration.env = { MODERATY_ENVIRONMENT: 'production', MODERATY_RELEASE: '496565f' };
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	emitOperationalEvent({ type: 'session_lookup_failed', severity: 'error', category: 'database', route: '/(app)/channels/[id]', requestId });
	expect(log).toHaveBeenCalledTimes(1);
	expect(JSON.parse(log.mock.calls[0][0])).toEqual({ version: 1, type: 'session_lookup_failed', severity: 'error', category: 'database', route: '/(app)/channels/[id]', requestId, environment: 'production', release: '496565f' });
});

test('drops raw fields and rejects unsafe values rather than serializing them', () => {
	const secret = 'synthetic-private-value';
	configuration.env = { MODERATY_ENVIRONMENT: secret, MODERATY_RELEASE: 'https://private.invalid/?token=' + secret };
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	emitOperationalEvent({ type: secret, severity: secret, category: secret, route: '/channels/' + secret + '?email=person@example.invalid', requestId: secret,
		error: new Error(secret), url: 'https://private.invalid/?secret=' + secret, headers: { cookie: secret }, email: 'person@example.invalid', payment: secret, commentBody: secret } as never);
	const output = log.mock.calls[0][0];
	expect(output).not.toContain(secret);
	expect(output).not.toContain('person@example.invalid');
	expect(JSON.parse(output)).toEqual({ version: 1, type: 'unexpected_server_error', severity: 'error', category: 'unknown', route: null, requestId: null, environment: 'unknown', release: null });
});

test('a throwing event getter cannot leak or prevent a request outcome', () => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	const event = Object.defineProperty({}, 'type', { get() { throw new Error('synthetic-private-value'); } });
	expect(() => emitOperationalEvent(event as never)).not.toThrow();
	expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-value');
});

test('a failed output sink emits a fixed stderr warning and never throws', () => {
	vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('synthetic-private-value'); });
	const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
	expect(() => emitOperationalEvent({ type: 'session_lookup_failed', severity: 'error', category: 'database', requestId, route: '/' })).not.toThrow();
	expect(stderr).toHaveBeenCalledWith('operational logging failed\n');
});

test('warn and info use their own channels without logging a healthy request', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const info = vi.spyOn(console, 'info').mockImplementation(() => {});
	emitOperationalEvent({ type: 'request_disconnected', severity: 'warn', category: 'client_disconnect', requestId, route: '/' });
	emitOperationalEvent({ type: 'request_not_found', severity: 'info', category: 'not_found', requestId, route: null });
	expect(JSON.parse(warn.mock.calls[0][0]).severity).toBe('warn');
	expect(JSON.parse(info.mock.calls[0][0]).severity).toBe('info');
});

test('changing accessors cannot swap validated values for private data', () => {
	let routeReads = 0;
	let requestReads = 0;
	let releaseReads = 0;
	const privateValue = 'synthetic-private-value';
	configuration.env = { MODERATY_ENVIRONMENT: 'test', get MODERATY_RELEASE() { return ++releaseReads <= 2 ? '496565f' : privateValue; } };
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	emitOperationalEvent({ type: 'session_lookup_failed', severity: 'error', category: 'database',
		get route() { return ++routeReads <= 2 ? '/' : '/private?token=' + privateValue; },
		get requestId() { return ++requestReads <= 2 ? requestId : privateValue; } });
	expect(JSON.stringify(log.mock.calls)).not.toContain(privateValue);
	expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ route: '/', requestId, release: '496565f' });
	expect([routeReads, requestReads, releaseReads]).toEqual([1, 1, 1]);
});

test('both output and stderr failures stay contained', () => {
	vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('synthetic-private-value'); });
	const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('synthetic-private-value'); });
	expect(() => emitOperationalEvent({ type: 'session_lookup_failed', severity: 'error', category: 'database', route: '/', requestId })).not.toThrow();
	expect(stderr).toHaveBeenCalledWith('operational logging failed\n');
});


test('diagnostics distinguish error classes and call sites without revealing messages or stack text', () => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	const send = (message: string, site: number) => {
		const failure = new TypeError(message);
		failure.stack = `${message}\n    at work (/private/synthetic-private-value.ts:${site}:9)`;
		emitOperationalEvent({ type: 'unexpected_server_error', severity: 'error', category: 'unexpected', route: '/', requestId, diagnosticError: failure } as never);
		return JSON.parse(log.mock.calls.at(-1)![0]);
	};
	const first = send('synthetic-private-value', 1);
	const sameSite = send('a different private message', 1);
	const otherSite = send('synthetic-private-value', 2);
	expect(first.errorKind).toBe('TypeError');
	expect(first.errorFingerprint).toMatch(/^[a-f0-9]{64}$/);
	expect(sameSite.errorFingerprint).toBe(first.errorFingerprint);
	expect(otherSite.errorFingerprint).not.toBe(first.errorFingerprint);
	expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-value');
	expect(JSON.stringify(log.mock.calls)).not.toContain('a different private message');
});

test('hostile diagnostic metadata stays contained and oversized stacks are not processed', () => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	const hostile = Object.defineProperty(new Error(), 'stack', { get() { throw new Error('synthetic-private-value'); } });
	for (const diagnosticError of [hostile, new Proxy({}, { getPrototypeOf() { throw new Error('synthetic-private-value'); } })]) {
		expect(() => emitOperationalEvent({ type: 'unexpected_server_error', severity: 'error', category: 'unexpected', route: '/', requestId, diagnosticError } as never)).not.toThrow();
		expect(JSON.parse(log.mock.calls.at(-1)![0]).errorFingerprint).toBeNull();
	}
	const oversized = new Error();
	oversized.stack = 'at '.repeat(30_000);
	emitOperationalEvent({ type: 'unexpected_server_error', severity: 'error', category: 'unexpected', route: '/', requestId, diagnosticError: oversized } as never);
	expect(JSON.parse(log.mock.calls.at(-1)![0]).errorFingerprint).toBeNull();
	expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-value');
});

test('structured diagnostics preserve known provider causes without exposing private text', () => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	const send = (code: string) => {
		const cause = Object.assign(new Error('synthetic-private-provider-message'), {code, httpStatus:503});
		const failure = new Error('synthetic-private-wrapper-message', {cause});
		emitOperationalEvent({type:'unexpected_server_error', severity:'error', category:'database', route:'/', requestId, diagnosticError:failure});
		return JSON.parse(log.mock.calls.at(-1)![0]);
	};
	const busy = send('SQLITE_BUSY');
	const unavailable = send('ECONNREFUSED');
	expect(busy.errorCauses).toEqual([{kind:'Error', code:null, httpStatus:null}, {kind:'Error', code:'SQLITE_BUSY', httpStatus:503}]);
	expect(unavailable.errorCauses[1].code).toBe('ECONNREFUSED');
	expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private');
});
