// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {
		GOOGLE_CLIENT_ID: 'client-id',
		GOOGLE_CLIENT_SECRET: 'client-secret',
		APP_URL: 'http://localhost:5173'
	} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { exchangeGoogleCode, revokeGoogleToken } from './google';

const PREFIX = 'google login token exchange';
const USER_ERROR = 'Google sign-in failed — please retry';

function fetchMock(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
	const fn = vi.fn(impl);
	vi.stubGlobal('fetch', fn);
	return fn;
}

function tokenResponse(body: string, status = 200) {
	return new Response(body, { status });
}

async function captureExchange(
	code = 'abc',
	redirectPath = '/api/auth/google/login/callback'
): Promise<{ status: number; body?: { message: string } }> {
	try {
		await exchangeGoogleCode(code, redirectPath, PREFIX, USER_ERROR);
		throw new Error('exchangeGoogleCode resolved when a throw was expected');
	} catch (e) {
		return e as { status: number; body?: { message: string } };
	}
}

beforeEach(() => {
	mocks.env.GOOGLE_CLIENT_ID = 'client-id';
	mocks.env.GOOGLE_CLIENT_SECRET = 'client-secret';
	mocks.env.APP_URL = 'http://localhost:5173';
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test.each([
	['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID is not configured'],
	['GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET is not configured'],
	['APP_URL', 'APP_URL is not configured']
] as const)('exchange fails loudly with 500 when %s is not configured', async (key, message) => {
	mocks.env[key] = undefined;
	const fetchSpy = fetchMock(async () => {
		throw new Error('fetch must not be called when env is missing');
	});

	const thrown = await captureExchange();

	expect(thrown.status).toBe(500);
	expect(thrown.body?.message).toBe(message);
	expect(fetchSpy).not.toHaveBeenCalled();
});

test('exchange posts the authorization code as a form to the token endpoint', async () => {
	const fetchSpy = fetchMock(async () =>
		tokenResponse(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }))
	);

	const tokens = await exchangeGoogleCode('the-code', '/api/auth/google/login/callback', PREFIX, USER_ERROR);

	expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt' });
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
	expect(url).toBe('https://oauth2.googleapis.com/token');
	expect(init.method).toBe('POST');
	expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
	const body = init.body as URLSearchParams;
	expect(body.get('code')).toBe('the-code');
	expect(body.get('client_id')).toBe('client-id');
	expect(body.get('client_secret')).toBe('client-secret');
	expect(body.get('redirect_uri')).toBe('http://localhost:5173/api/auth/google/login/callback');
	expect(body.get('grant_type')).toBe('authorization_code');
});

test('exchange returns only the access token when Google sends no refresh token', async () => {
	fetchMock(async () => tokenResponse(JSON.stringify({ access_token: 'at' })));

	const tokens = await exchangeGoogleCode('abc', '/cb', PREFIX, USER_ERROR);

	expect(tokens.accessToken).toBe('at');
	expect(tokens.refreshToken).toBeUndefined();
});

test.each([
	['a number', 123],
	['an empty string', '']
])('exchange drops a refresh token that is %s', async (_name, refreshToken) => {
	fetchMock(async () => tokenResponse(JSON.stringify({ access_token: 'at', refresh_token: refreshToken })));

	const tokens = await exchangeGoogleCode('abc', '/cb', PREFIX, USER_ERROR);

	expect(tokens.accessToken).toBe('at');
	expect(tokens.refreshToken).toBeUndefined();
});

test('exchange logs the network failure and throws the generic 502 on a request error', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	fetchMock(async () => {
		throw new Error('socket hang up');
	});

	const thrown = await captureExchange();

	expect(thrown.status).toBe(502);
	expect(thrown.body?.message).toBe(USER_ERROR);
	expect(errorSpy).toHaveBeenCalledWith(`${PREFIX} request failed: socket hang up`);
});

test('exchange logs Google error fields and throws the generic 502 on a non-OK status', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	fetchMock(async () =>
		tokenResponse(JSON.stringify({ error: 'invalid_grant', error_description: 'Code was already redeemed' }), 400)
	);

	const thrown = await captureExchange();

	expect(thrown.status).toBe(502);
	expect(thrown.body?.message).toBe(USER_ERROR);
	expect(errorSpy).toHaveBeenCalledWith(`${PREFIX} failed: 400 invalid_grant: Code was already redeemed`);
});

test('exchange logs the error field without a description when none is sent', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	fetchMock(async () => tokenResponse(JSON.stringify({ error: 'invalid_grant' }), 400));

	const thrown = await captureExchange();

	expect(thrown.status).toBe(502);
	expect(errorSpy).toHaveBeenCalledWith(`${PREFIX} failed: 400 invalid_grant`);
});

test.each([
	['a non-JSON body', 'proxy error page'],
	['valid JSON null', 'null'],
	['a non-string error field', JSON.stringify({ error: 42 })]
])('exchange logs "no error detail" when the error body has %s', async (_name, body) => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	fetchMock(async () => tokenResponse(body, 503));

	const thrown = await captureExchange();

	expect(thrown.status).toBe(502);
	expect(errorSpy).toHaveBeenCalledWith(`${PREFIX} failed: 503 no error detail`);
});

test('exchange ignores a non-string error description', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	fetchMock(async () =>
		tokenResponse(JSON.stringify({ error: 'invalid_grant', error_description: 42 }), 400)
	);

	const thrown = await captureExchange();

	expect(thrown.status).toBe(502);
	expect(errorSpy).toHaveBeenCalledWith(`${PREFIX} failed: 400 invalid_grant`);
});

test('exchange returns 502 and logs when the token response is not valid JSON', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	fetchMock(async () => tokenResponse('not json at all'));

	const thrown = await captureExchange();

	expect(thrown.status).toBe(502);
	expect(thrown.body?.message).toBe('invalid response from Google — please retry');
	expect(errorSpy).toHaveBeenCalledWith(`${PREFIX} returned invalid JSON`);
});

test.each([['null', 'null'], ['a string', '"just a string"'], ['a number', '123']])(
	'exchange returns 502 and logs when the token response is %s',
	async (_name, body) => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		fetchMock(async () => tokenResponse(body));

		const thrown = await captureExchange();

		expect(thrown.status).toBe(502);
		expect(thrown.body?.message).toBe('invalid response from Google — please retry');
		expect(errorSpy).toHaveBeenCalledWith(`${PREFIX} returned a non-object body`);
	}
);

test.each([
	['missing', undefined],
	['an empty string', ''],
	['a number', 123]
])('exchange returns 502 and logs when the access token is %s', async (_name, accessToken) => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	const payload: Record<string, unknown> = { refresh_token: 'rt' };
	if (accessToken !== undefined) payload.access_token = accessToken;
	fetchMock(async () => tokenResponse(JSON.stringify(payload)));

	const thrown = await captureExchange();

	expect(thrown.status).toBe(502);
	expect(thrown.body?.message).toBe('invalid response from Google — please retry');
	expect(errorSpy).toHaveBeenCalledWith(`${PREFIX} returned 200 without an access_token`);
});

test('revoke posts the token as a form to the revocation endpoint', async () => {
	const fetchSpy = fetchMock(async () => tokenResponse('', 200));

	await revokeGoogleToken('the-refresh-token', 'account deletion channel UC1');

	expect(fetchSpy).toHaveBeenCalledTimes(1);
	const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
	expect(url).toBe('https://oauth2.googleapis.com/revoke');
	expect(init.method).toBe('POST');
	expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
	expect((init.body as URLSearchParams).get('token')).toBe('the-refresh-token');
});

test('revoke logs with the revocation prefix and throws a descriptive error on a non-OK status', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	fetchMock(async () => tokenResponse(JSON.stringify({ error: 'invalid_token' }), 400));

	await expect(revokeGoogleToken('tok', 'account deletion channel UC1')).rejects.toThrow(
		'Google token revocation failed'
	);
	expect(errorSpy).toHaveBeenCalledWith('account deletion channel UC1 revocation failed: 400 invalid_token');
});

test('revoke throws a descriptive error on a network failure', async () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	fetchMock(async () => {
		throw new Error('connection reset');
	});

	await expect(revokeGoogleToken('tok', 'account deletion channel UC1')).rejects.toThrow(
		'Google token revocation failed'
	);
	expect(errorSpy).toHaveBeenCalledWith('account deletion channel UC1 revocation request failed: connection reset');
});
