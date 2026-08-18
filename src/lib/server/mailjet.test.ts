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
		MJ_APIKEY_PUBLIC: 'api-key',
		MJ_APIKEY_PRIVATE: 'secret-key',
		MAILJET_FROM_EMAIL: 'no-reply@moderaty.app',
		MAILJET_FROM_NAME: 'Moderaty Mail'
	} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { sendMailjetMessage, type MailjetMessage } from './mailjet';

const MESSAGE: MailjetMessage = {
	toEmail: 'fan@example.com',
	toName: 'Fan',
	subject: 'Confirm your contact request — Moderaty',
	textPart: 'Confirm by opening this link: https://moderaty.app/contact/verify?token=abc',
	htmlPart: '<p>Confirm by opening <a href="https://moderaty.app/contact/verify?token=abc">this link</a>.</p>'
};

function fetchMock(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
	const fn = vi.fn(impl);
	vi.stubGlobal('fetch', fn);
	return fn;
}

function mailjetSuccessResponse() {
	return new Response(
		JSON.stringify({
			Messages: [
				{
					Status: 'success',
					To: [{ Email: 'fan@example.com', MessageUUID: 'uuid-1', MessageID: 123, MessageHref: 'https://api.mailjet.com/v3/message/123' }]
				}
			]
		}),
		{ status: 200 }
	);
}

async function expectSendThrows(label: string) {
	try {
		await sendMailjetMessage(MESSAGE);
		throw new Error(`${label}: sendMailjetMessage resolved when a throw was expected`);
	} catch (error) {
		expect(String((error as Error).message)).toMatch(/could not be sent/);
	}
}

beforeEach(() => {
	mocks.env.MJ_APIKEY_PUBLIC = 'api-key';
	mocks.env.MJ_APIKEY_PRIVATE = 'secret-key';
	mocks.env.MAILJET_FROM_EMAIL = 'no-reply@moderaty.app';
	mocks.env.MAILJET_FROM_NAME = 'Moderaty Mail';
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test('posts to the v3.1 send endpoint with Basic auth and the documented body shape', async () => {
	const fetchSpy = fetchMock(async () => mailjetSuccessResponse());

	const result = await sendMailjetMessage(MESSAGE);

	expect(fetchSpy).toHaveBeenCalledTimes(1);
	const [url, init] = fetchSpy.mock.calls[0] as [RequestInfo | URL, RequestInit];
	expect(String(url)).toBe('https://api.mailjet.com/v3.1/send');
	expect(init.method).toBe('POST');
	const auth = (init.headers as Record<string, string>).Authorization;
	expect(auth).toBe(`Basic ${Buffer.from('api-key:secret-key').toString('base64')}`);
	expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

	const body = JSON.parse(String(init.body)) as {
		Messages: Array<{
			From: { Email: string; Name: string };
			To: Array<{ Email: string; Name: string }>;
			Subject: string;
			TextPart: string;
			HTMLPart: string;
		}>;
	};
	expect(body.Messages).toHaveLength(1);
	const message = body.Messages[0];
	expect(message.From).toEqual({ Email: 'no-reply@moderaty.app', Name: 'Moderaty Mail' });
	expect(message.To).toEqual([{ Email: 'fan@example.com', Name: 'Fan' }]);
	expect(message.Subject).toBe(MESSAGE.subject);
	expect(message.TextPart).toBe(MESSAGE.textPart);
	expect(message.HTMLPart).toBe(MESSAGE.htmlPart);
	expect(result).toEqual({ messageId: 123, messageUuid: 'uuid-1' });
});

test('defaults the sender name to Moderaty when MAILJET_FROM_NAME is unset', async () => {
	mocks.env.MAILJET_FROM_NAME = undefined;
	const fetchSpy = fetchMock(async () => mailjetSuccessResponse());

	await sendMailjetMessage(MESSAGE);

	const [, init] = fetchSpy.mock.calls[0] as [RequestInfo | URL, RequestInit];
	const body = JSON.parse(String(init.body)) as { Messages: Array<{ From: { Name: string } }> };
	expect(body.Messages[0].From.Name).toBe('Moderaty');
});

test.each([
	['MJ_APIKEY_PUBLIC', 'MJ_APIKEY_PUBLIC is not configured'],
	['MJ_APIKEY_PRIVATE', 'MJ_APIKEY_PRIVATE is not configured'],
	['MAILJET_FROM_EMAIL', 'MAILJET_FROM_EMAIL is not configured']
] as const)('fails loudly when %s is missing and never calls fetch', async (key, message) => {
	mocks.env[key] = undefined;
	const fetchSpy = fetchMock(async () => {
		throw new Error('fetch must not be called when env is missing');
	});

	try {
		await sendMailjetMessage(MESSAGE);
		throw new Error('sendMailjetMessage resolved when a throw was expected');
	} catch (error) {
		expect(String((error as Error).message)).toContain(message);
	}
	expect(fetchSpy).not.toHaveBeenCalled();
});

test('fails loudly with a generic message on a non-OK HTTP status', async () => {
	fetchMock(async () => new Response('{"ErrorInfo":"bad creds","ErrorMessage":"Unauthorized"}', { status: 401 }));
	await expectSendThrows('HTTP 401');
});

test('fails loudly when the response body is not JSON', async () => {
	fetchMock(async () => new Response('<html>proxy error</html>', { status: 200 }));
	await expectSendThrows('invalid JSON');
});

test('fails loudly when MailJet reports a non-success message status', async () => {
	fetchMock(async () => new Response(JSON.stringify({ Messages: [{ Status: 'error' }] }), { status: 200 }));
	await expectSendThrows('rejected status');
});

test('fails loudly when the response carries no Messages array', async () => {
	fetchMock(async () => new Response(JSON.stringify({}), { status: 200 }));
	await expectSendThrows('no Messages');
});

test('fails loudly on a network failure and never surfaces the raw body', async () => {
	fetchMock(async () => {
		throw new TypeError('fetch failed');
	});
	await expectSendThrows('network');
});
