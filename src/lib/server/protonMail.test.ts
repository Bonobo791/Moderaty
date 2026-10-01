import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {
		PROTON_SMTP_USERNAME: 'no-reply@moderaty.app',
		PROTON_SMTP_TOKEN: 'smtp-token',
		PROTON_FROM_NAME: 'Moderaty Mail'
	} as Record<string, string | undefined>,
	createTransport: vi.fn(),
	sendMail: vi.fn(),
	close: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('nodemailer', () => ({
	default: { createTransport: mocks.createTransport },
	createTransport: mocks.createTransport
}));

import { DeadlineExceededError } from './http';
import { sendProtonMailEmail, type ProtonMailMessage } from './protonMail';

const MESSAGE: ProtonMailMessage = {
	toEmail: 'fan@example.com',
	subject: 'Confirm your contact request — Moderaty',
	textPart: 'Confirm by opening this link: https://moderaty.app/contact/verify?token=abc',
	htmlPart: '<p>Confirm by opening <a href="https://moderaty.app/contact/verify?token=abc">this link</a>.</p>'
};

function acceptedInfo(overrides: Record<string, unknown> = {}) {
	return {
		envelope: { from: 'no-reply@moderaty.app', to: ['fan@example.com'] },
		messageId: '<msg-1@moderaty.app>',
		accepted: ['fan@example.com'],
		rejected: [],
		response: '250 2.0.0 Ok: queued as ABC123',
		...overrides
	};
}

async function expectSendThrows(label: string) {
	try {
		await sendProtonMailEmail(MESSAGE);
		throw new Error(`${label}: sendProtonMailEmail resolved when a throw was expected`);
	} catch (error) {
		expect(String((error as Error).message)).toMatch(/could not be sent/);
	}
}

beforeEach(() => {
	mocks.env.PROTON_SMTP_USERNAME = 'no-reply@moderaty.app';
	mocks.env.PROTON_SMTP_TOKEN = 'smtp-token';
	mocks.env.PROTON_FROM_NAME = 'Moderaty Mail';
	mocks.createTransport.mockReset();
	mocks.sendMail.mockReset();
	mocks.close.mockReset();
	mocks.sendMail.mockResolvedValue(acceptedInfo());
	mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail, close: mocks.close });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test('opens smtp.protonmail.ch:587 with mandatory STARTTLS, strict certificates, token auth, and a 10s phase budget', async () => {
	await sendProtonMailEmail(MESSAGE);

	expect(mocks.createTransport).toHaveBeenCalledTimes(1);
	const opts = mocks.createTransport.mock.calls[0][0] as Record<string, unknown>;
	expect(opts.host).toBe('smtp.protonmail.ch');
	expect(opts.port).toBe(587);
	expect(opts.secure).toBe(false);
	expect(opts.requireTLS).toBe(true);
	expect(opts.auth).toEqual({ user: 'no-reply@moderaty.app', pass: 'smtp-token' });
	expect(opts.tls).toMatchObject({ rejectUnauthorized: true });
	expect(opts.connectionTimeout).toBe(10_000);
	expect(opts.socketTimeout).toBe(10_000);
});

test('sends one bare recipient with the SMTP username as From address and both body parts, then closes the transport', async () => {
	const result = await sendProtonMailEmail(MESSAGE);

	expect(mocks.sendMail).toHaveBeenCalledTimes(1);
	const mail = mocks.sendMail.mock.calls[0][0] as Record<string, unknown>;
	expect(mail.from).toEqual({ name: 'Moderaty Mail', address: 'no-reply@moderaty.app' });
	expect(mail.to).toBe('fan@example.com');
	expect(mail.subject).toBe(MESSAGE.subject);
	expect(mail.text).toBe(MESSAGE.textPart);
	expect(mail.html).toBe(MESSAGE.htmlPart);
	expect(result).toEqual({ messageId: '<msg-1@moderaty.app>' });
	expect(mocks.close).toHaveBeenCalled();
});

test('defaults the sender name to Moderaty when PROTON_FROM_NAME is unset', async () => {
	mocks.env.PROTON_FROM_NAME = undefined;

	await sendProtonMailEmail(MESSAGE);

	const mail = mocks.sendMail.mock.calls[0][0] as { from: { name: string } };
	expect(mail.from.name).toBe('Moderaty');
});

test.each([
	['PROTON_SMTP_USERNAME', 'PROTON_SMTP_USERNAME is not configured'],
	['PROTON_SMTP_TOKEN', 'PROTON_SMTP_TOKEN is not configured']
] as const)('fails loudly when %s is missing and never opens a connection', async (key, message) => {
	mocks.env[key] = undefined;

	try {
		await sendProtonMailEmail(MESSAGE);
		throw new Error('sendProtonMailEmail resolved when a throw was expected');
	} catch (error) {
		expect(String((error as Error).message)).toContain(message);
	}
	expect(mocks.createTransport).not.toHaveBeenCalled();
});

test('fails loudly when PROTON_SMTP_USERNAME is not a bare e-mail address', async () => {
	mocks.env.PROTON_SMTP_USERNAME = 'not-an-address';

	await expect(sendProtonMailEmail(MESSAGE)).rejects.toThrow(/PROTON_SMTP_USERNAME/);
	expect(mocks.createTransport).not.toHaveBeenCalled();
});

test('fails loudly when PROTON_FROM_NAME carries a control character', async () => {
	mocks.env.PROTON_FROM_NAME = 'Moderaty\r\nX-Injected: yes';

	await expect(sendProtonMailEmail(MESSAGE)).rejects.toThrow(/PROTON_FROM_NAME/);
	expect(mocks.createTransport).not.toHaveBeenCalled();
});

test.each([
	['fan@example.com,mallory@evil.example', 'address list'],
	['fan@example.com;mallory@evil.example', 'semicolon list'],
	['Fan <fan@example.com>', 'display name'],
	['fan@example.com\r\nRCPT TO:<mallory@evil.example>', 'CRLF injection'],
	['a b@example.com', 'embedded whitespace'],
	['fan@example.com ', 'trailing whitespace'],
	['fan@example.com\x00', 'NUL control character'],
	[`${'a'.repeat(250)}@b.co`, 'over 254 characters'],
	['', 'empty'],
	['no-at-sign', 'missing @']
])('rejects an unsafe recipient (%s — %s) before any connection', async (toEmail) => {
	await expect(sendProtonMailEmail({ ...MESSAGE, toEmail })).rejects.toThrow(/could not be sent/);
	expect(mocks.createTransport).not.toHaveBeenCalled();
});

test('rejects CR/LF in the subject before any connection', async () => {
	await expect(sendProtonMailEmail({ ...MESSAGE, subject: 'Hi\r\nBcc: mallory@evil.example' })).rejects.toThrow(
		/could not be sent/
	);
	expect(mocks.createTransport).not.toHaveBeenCalled();
});

test.each([
	['empty subject', { subject: '' }],
	['empty text part', { textPart: '' }],
	['empty html part', { htmlPart: '' }]
] as const)('rejects a message with %s before any connection', async (_label, patch) => {
	await expect(sendProtonMailEmail({ ...MESSAGE, ...patch })).rejects.toThrow(/could not be sent/);
	expect(mocks.createTransport).not.toHaveBeenCalled();
});

test.each([
	['the server rejected the recipient', acceptedInfo({ rejected: ['fan@example.com'] })],
	['accepted is empty', acceptedInfo({ accepted: [] })],
	['accepted names a different mailbox', acceptedInfo({ accepted: ['other@example.com'] })],
	['accepted carries extra envelopes', acceptedInfo({ accepted: ['fan@example.com', 'other@example.com'] })],
	['the final response is not 250', acceptedInfo({ response: '451 4.7.1 try again later' })],
	['the final response is missing', acceptedInfo({ response: undefined })],
	['the acceptance carries no message id', acceptedInfo({ messageId: undefined })],
	['the acceptance is not the documented shape', { messageId: '<x>' }]
])('fails loudly when %s', async (_label, info) => {
	mocks.sendMail.mockResolvedValue(info);

	await expectSendThrows('malformed acceptance');
	expect(mocks.close).toHaveBeenCalled();
});

test('a generated message id alone is not proof of acceptance', async () => {
	mocks.sendMail.mockResolvedValue({ messageId: '<forged@moderaty.app>' });
	await expectSendThrows('messageId without envelope verdicts');
});

test.each([
	['authentication failure', { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }],
	['connection failure', { code: 'ECONNECTION', command: 'CONN' }],
	['socket timeout', { code: 'ETIMEDOUT' }],
	['TLS failure', { code: 'CERT_HAS_EXPIRED' }],
	['provider throttling', { code: 'EMESSAGE', responseCode: 451 }],
	['provider rejection', { code: 'EMESSAGE', responseCode: 550 }]
])('fails loudly on %s without leaking credentials or bodies to the log', async (_label, smtpError) => {
	const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	mocks.sendMail.mockRejectedValue(Object.assign(new Error('smtp gone'), smtpError));

	await expectSendThrows('SMTP failure');

	// Sanitized diagnostics must actually reach the log — codes, never secrets.
	const logged = JSON.stringify(errSpy.mock.calls);
	expect(errSpy).toHaveBeenCalled();
	expect(logged).toContain(String(smtpError.code));
	expect(logged).not.toContain('smtp-token');
	expect(logged).not.toContain('token=abc');
	expect(logged).not.toContain(MESSAGE.textPart);
});

test('a deadline already spent throws DeadlineExceededError without opening a connection', async () => {
	await expect(sendProtonMailEmail(MESSAGE, Date.now() - 1)).rejects.toBeInstanceOf(DeadlineExceededError);
	expect(mocks.createTransport).not.toHaveBeenCalled();
});

test('the 10-second whole-operation guard cancels the transport and closes it', async () => {
	vi.useFakeTimers();
	mocks.sendMail.mockReturnValue(new Promise(() => {}));

	const settled = sendProtonMailEmail(MESSAGE).then(
		() => null,
		(error: unknown) => error
	);
	await vi.advanceTimersByTimeAsync(10_001);
	const error = await settled;
	expect(error).not.toBeNull();
	expect(error).not.toBeInstanceOf(DeadlineExceededError);
	expect(String((error as Error).message)).toMatch(/could not be sent/);
	expect(mocks.close).toHaveBeenCalled();
});

test('a caller deadline expiring mid-send rejects DeadlineExceededError and tears down the connection', async () => {
	vi.useFakeTimers();
	mocks.sendMail.mockReturnValue(new Promise(() => {}));

	const send = sendProtonMailEmail(MESSAGE, Date.now() + 1_000);
	const assertion = expect(send).rejects.toBeInstanceOf(DeadlineExceededError);
	await vi.advanceTimersByTimeAsync(1_001);
	await assertion;
	expect(mocks.close).toHaveBeenCalled();
});

test('a late acceptance after the deadline is never reported as success', async () => {
	vi.useFakeTimers();
	mocks.sendMail.mockImplementation(
		() => new Promise((resolve) => setTimeout(() => resolve(acceptedInfo()), 5_000))
	);

	const send = sendProtonMailEmail(MESSAGE, Date.now() + 1_000);
	const assertion = expect(send).rejects.toBeInstanceOf(DeadlineExceededError);
	await vi.advanceTimersByTimeAsync(6_000);
	await assertion;
	expect(mocks.close).toHaveBeenCalled();
});
