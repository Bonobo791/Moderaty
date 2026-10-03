import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, Socket, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls';

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

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

test("accepts an apostrophe in the recipient local part (a legal RFC mailbox)", async () => {
	const toEmail = "o'connor@example.com";
	mocks.sendMail.mockResolvedValue(
		acceptedInfo({ accepted: [toEmail], envelope: { from: 'no-reply@moderaty.app', to: [toEmail] } })
	);

	const result = await sendProtonMailEmail({ ...MESSAGE, toEmail });

	expect(mocks.sendMail).toHaveBeenCalledTimes(1);
	expect((mocks.sendMail.mock.calls[0][0] as { to: string }).to).toBe(toEmail);
	expect(result).toEqual({ messageId: '<msg-1@moderaty.app>' });
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

test('an acceptance committed while the deadline passes still counts as delivered', async () => {
	vi.useFakeTimers();
	mocks.sendMail.mockImplementation(async () => {
		// The provider accepted the message; the clock then moved past the
		// caller deadline before the post-send check ran. A confirmed side
		// effect reported as a deferral makes the sweep resend a delivered
		// warning (codex).
		vi.setSystemTime(Date.now() + 2_000);
		return acceptedInfo();
	});

	const result = await sendProtonMailEmail(MESSAGE, Date.now() + 1_000);
	expect(result).toEqual({ messageId: '<msg-1@moderaty.app>' });
});

test('an unconfirmed result discovered after the deadline still defers', async () => {
	vi.useFakeTimers();
	mocks.sendMail.mockImplementation(async () => {
		vi.setSystemTime(Date.now() + 2_000);
		return { messageId: '<x>' }; // no envelope verdicts — acceptance unproven
	});

	await expect(sendProtonMailEmail(MESSAGE, Date.now() + 1_000)).rejects.toBeInstanceOf(DeadlineExceededError);
});

test('the transport is given a caller-owned socket the guard can always reach', async () => {
	// A getSocket seam cannot be trusted: send() only merges its result when
	// it carries a proxy `connection`, silently dropping a bare {socket}
	// (MOD-238). The `socket` option is the handle SMTPConnection connects on.
	await sendProtonMailEmail(MESSAGE);

	const opts = mocks.createTransport.mock.calls[0][0] as Record<string, unknown>;
	expect(opts.socket).toBeInstanceOf(Socket);
	expect(opts.getSocket).toBeUndefined();
});

test('the guard destroys the live SMTP socket so a late acceptance can never complete', async () => {
	vi.useFakeTimers();
	// Mirror real nodemailer: the transport drives .connect() on the
	// caller-supplied socket option, then holds the provider response until
	// the socket dies — the only settlement a real server can still deliver.
	let liveSocket: { destroyed: boolean } | undefined;
	mocks.createTransport.mockImplementationOnce((options: Record<string, unknown>) => {
		liveSocket = options.socket as { destroyed: boolean };
		return {
			close: mocks.close,
			sendMail: vi.fn(
				() =>
					new Promise((resolve) => {
						const waiter = setInterval(() => {
							if (liveSocket!.destroyed) {
								clearInterval(waiter);
								resolve(acceptedInfo());
							}
						}, 5);
					})
			)
		};
	});

	const promise = sendProtonMailEmail(MESSAGE);
	const assertion = expect(promise).rejects.toThrow('e-mail could not be sent (send timed out)');
	await vi.advanceTimersByTimeAsync(11_000);
	await assertion;
	expect(liveSocket).toBeDefined();
	expect(liveSocket!.destroyed).toBe(true);
});

test('a deadline spent during transport setup never opens an SMTP connection', async () => {
	vi.useFakeTimers();
	mocks.createTransport.mockImplementationOnce(() => {
		vi.setSystemTime(Date.now() + 5_000);
		return { sendMail: mocks.sendMail, close: mocks.close };
	});
	await expect(sendProtonMailEmail(MESSAGE, Date.now() + 1_000)).rejects.toBeInstanceOf(DeadlineExceededError);
	expect(mocks.sendMail).not.toHaveBeenCalled();
});

test('the guard is armed with the budget left after setup, not the entry-time budget', async () => {
	vi.useFakeTimers();
	// createTransport runs after timeoutMs is computed: 4s of an 8s caller
	// deadline is gone before the timer exists. If the guard still uses the
	// entry-time budget it fires 4s late and the send outlives the deadline
	// (codex). Assert the deadline-time teardown, not settlement — a stale
	// timer would leave the send pending and this test must not hang on it.
	mocks.createTransport.mockImplementationOnce(() => {
		vi.setSystemTime(Date.now() + 4_000);
		return { sendMail: mocks.sendMail, close: mocks.close };
	});
	mocks.sendMail.mockReturnValue(new Promise(() => {}));

	const send = sendProtonMailEmail(MESSAGE, Date.now() + 8_000);
	void send.catch(() => {});
	await vi.advanceTimersByTimeAsync(4_001); // the caller deadline has now passed
	expect(mocks.close).toHaveBeenCalled();
	await expect(send).rejects.toBeInstanceOf(DeadlineExceededError);
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

/**
 * Controlled local SMTP integration check (MOD-118): mocked sendMail alone
 * cannot prove the transport negotiates STARTTLS or that the deadline guard
 * tears down a real socket. The nodemailer factory is swapped for a REAL
 * transport redirected to an in-process server — host, port and the trust
 * root are the only overrides; every other option (requireTLS, token auth,
 * phase budgets) is the production value, and all of sendProtonMailEmail's
 * own validation, timing and acceptance logic runs unmodified.
 */
describe('local SMTP integration', () => {
	interface SmtpSession {
		commands: string[]; // every client line, pre- and post-TLS
		sawStarttls: boolean;
		sawPostTlsEhlo: boolean;
		authUser: string | null;
		authSecret: string | null;
		mailFrom: string | null;
		rcptTo: string[];
		data: string;
		ended: Promise<void>; // resolves when the client socket fully closes
		stallTimersDrained: boolean; // set when the close hook clears a pending DATA stall
		stallFired: boolean; // set when the armed DATA-stall callback actually runs
	}

	let secureContext: SecureContext;
	let realCreateTransport: typeof import('nodemailer').createTransport;
	let server: Server;
	let serverPort: number;
	let sessions: SmtpSession[];
	let sockets: Socket[];
	let greet: boolean;
	let authOk: boolean;
	let stallDataMs: number;
	let disconnectAfterData: boolean;

	beforeAll(async () => {
		realCreateTransport = (await vi.importActual<typeof import('nodemailer')>('nodemailer')).createTransport;
		// Throwaway self-signed cert, generated per run and deleted with the
		// tmpdir — the client still disables verification explicitly below.
		const dir = mkdtempSync(join(tmpdir(), 'proton-mail-test-'));
		try {
			execFileSync(
				'openssl',
				['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=localhost'],
				{ stdio: 'pipe' }
			);
			secureContext = createSecureContext({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	beforeEach(async () => {
		sessions = [];
		sockets = [];
		greet = true;
		authOk = true;
		stallDataMs = 0;
		disconnectAfterData = false;
		server = createServer((socket) => {
			sockets.push(socket);
			const session: SmtpSession = {
				commands: [],
				sawStarttls: false,
				sawPostTlsEhlo: false,
				authUser: null,
				authSecret: null,
				mailFrom: null,
				rcptTo: [],
				data: '',
				ended: new Promise((resolve) => socket.once('close', resolve)),
				stallTimersDrained: false,
				stallFired: false
			};
			sessions.push(session);
			let tls = false;
			let inData = false;
			let buffer = '';
			let tlsSocket: TLSSocket | undefined;
			const wire = () => (tls ? tlsSocket! : socket);
			const write = (line: string) => wire().write(line + '\r\n');
			const command = (line: string) => {
				session.commands.push(line);
				const verb = line.split(' ')[0].toUpperCase();
				switch (verb) {
					case 'EHLO':
					case 'HELO':
						if (!tls) {
							// AUTH is advertised ONLY post-TLS, so a client that
							// skipped STARTTLS cannot reach credentials.
							write('250-localhost');
							write('250-STARTTLS');
							write('250 8BITMIME');
						} else {
							session.sawPostTlsEhlo = true;
							write('250-localhost');
							write('250-AUTH PLAIN LOGIN');
							write('250 8BITMIME');
						}
						return;
					case 'STARTTLS':
						session.sawStarttls = true;
						write('220 2.0.0 Ready to start TLS');
						socket.removeListener('data', feed);
						tlsSocket = new TLSSocket(socket, { isServer: true, secureContext });
						// An abrupt client RST is the asserted outcome of the
						// teardown tests — it must not crash the fixture.
						tlsSocket.on('error', () => {});
						tlsSocket.on('data', feed);
						tls = true;
						return;
					case 'AUTH': {
						if (!tls) return write('530 5.7.0 Must issue a STARTTLS command first');
						const parts = Buffer.from(line.split(' ')[2] ?? '', 'base64')
							.toString('utf8')
							.split('\0');
						session.authUser = parts[1] ?? null;
						session.authSecret = parts[2] ?? null;
						write(authOk ? '235 2.7.0 Authentication succeeded' : '535 5.7.8 Authentication credentials invalid');
						return;
					}
					case 'MAIL':
						if (!tls) return write('530 5.7.0 Must issue a STARTTLS command first');
						session.mailFrom = /<([^>]*)>/.exec(line)?.[1] ?? null;
						return write('250 2.1.0 OK');
					case 'RCPT':
						if (!tls) return write('530 5.7.0 Must issue a STARTTLS command first');
						session.rcptTo.push(/<([^>]*)>/.exec(line)?.[1] ?? line);
						return write('250 2.1.5 OK');
					case 'DATA': {
						if (!tls) return write('530 5.7.0 Must issue a STARTTLS command first');
						if (stallDataMs > 0) {
							// Hold the 354 past the caller deadline while emitting
							// multiline continuations — inbound bytes keep the
							// client's socketTimeout from firing, so only the
							// whole-operation guard can end the session (MOD-238).
							const chatter = setInterval(() => {
								const w = wire();
								if (w.destroyed || !w.writable) return clearInterval(chatter);
								w.write('354-still preparing\r\n');
							}, 50);
							const stall = setTimeout(() => {
								session.stallFired = true;
								clearInterval(chatter);
								const w = wire();
								if (w.destroyed || !w.writable) return;
								inData = true;
								write('354 End data with <CR><LF>.<CR><LF>');
							}, stallDataMs);
							// A teardown that wins the race drains both pending
							// callbacks with the session — a surviving timer would
							// retain the closure and keep firing against dead
							// sockets after the test ends (codeant).
							socket.once('close', () => {
								session.stallTimersDrained = true;
								clearInterval(chatter);
								clearTimeout(stall);
							});
							return;
						}
						inData = true;
						return write('354 End data with <CR><LF>.<CR><LF>');
					}
					case 'RSET':
					case 'NOOP':
						return write('250 2.0.0 OK');
					case 'QUIT':
						write('221 2.0.0 Bye');
						return wire().end();
					default:
						return write('502 5.5.2 Command not recognized');
				}
			};
			const feed = (chunk: Buffer) => {
				buffer += chunk.toString('utf8');
				let boundary;
				while ((boundary = buffer.indexOf('\r\n')) >= 0) {
					const line = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					if (inData) {
						if (line === '.') {
							inData = false;
							if (disconnectAfterData) { wire().end(); return; }
							write('250 2.0.0 Ok: queued as TEST-QUEUE-1');
						} else {
							session.data += line + '\n';
						}
					} else {
						command(line);
					}
				}
			};
			socket.on('data', feed);
			socket.on('error', () => {}); // client teardown asserts the close; RST is expected
			if (greet) write('220 localhost ESMTP test server');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		serverPort = (server.address() as { port: number }).port;
		// Same interception point as the unit tests, but the factory now builds
		// a genuine transport against the local server instead of a stub.
		mocks.createTransport.mockImplementation((options: Record<string, unknown>) =>
			realCreateTransport({
				...options,
				host: '127.0.0.1',
				port: serverPort,
				tls: { ...(options.tls as Record<string, unknown>), rejectUnauthorized: false }
			})
		);
	});

	afterEach(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
	});

	test('negotiates STARTTLS, authenticates with the SMTP token and delivers DATA over the TLS socket', async () => {
		const result = await sendProtonMailEmail(MESSAGE);

		expect(result.messageId).toMatch(/^<.+@moderaty\.app>$/);
		expect(sessions).toHaveLength(1);
		const session = sessions[0];
		// STARTTLS really ran: credentials and the envelope only exist post-TLS
		// (the server would have answered 530 to anything sent in plaintext).
		expect(session.sawStarttls).toBe(true);
		expect(session.sawPostTlsEhlo).toBe(true);
		expect(session.authUser).toBe('no-reply@moderaty.app');
		expect(session.authSecret).toBe('smtp-token');
		expect(session.mailFrom).toBe('no-reply@moderaty.app');
		expect(session.rcptTo).toEqual(['fan@example.com']);
		// The RFC822 body reached DATA intact: both MIME parts and headers.
		expect(session.data).toContain('To: fan@example.com');
		expect(session.data).toContain('text/plain');
		expect(session.data).toContain('text/html');
		await session.ended; // transport.close() terminated the conversation
	});

	test('a disconnect after the complete DATA body is ambiguous even when Nodemailer reports CONN', async () => {
		disconnectAfterData = true;
		await expect(sendProtonMailEmail(MESSAGE)).rejects.toMatchObject({ outcome: 'unknown' });
		expect(sessions[0].data).toContain('text/plain');
		expect(sessions[0].data).toContain('text/html');
	});

	test('fails loudly on a wire-level auth rejection', async () => {
		authOk = false;
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await expect(sendProtonMailEmail(MESSAGE)).rejects.toThrow(/authentication failure/);
		} finally {
			errSpy.mockRestore();
		}
		const session = sessions[0];
		expect(session.sawStarttls).toBe(true);
		expect(session.authUser).toBe('no-reply@moderaty.app');
		expect(session.mailFrom).toBeNull(); // the envelope never started
	});

	test('a caller deadline mid-greeting tears down the real socket before any SMTP command', async () => {
		greet = false; // the server accepts the TCP connection but never speaks
		const send = sendProtonMailEmail(MESSAGE, Date.now() + 300);
		await expect(send).rejects.toBeInstanceOf(DeadlineExceededError);
		expect(sessions).toHaveLength(1);
		await sessions[0].ended; // the guard's socket destroy ended the connection
		expect(sessions[0].commands).toHaveLength(0);
	});

	test('a caller deadline mid-DATA kills the session before the server consumes the body', async () => {
		stallDataMs = 600; // the 354 arrives only after the caller gave up
		const send = sendProtonMailEmail(MESSAGE, Date.now() + 300);
		// At the budget boundary the guard may fire a hair before the wall
		// deadline flips — caller-deadline deferral and provider timeout are
		// both correct; the contract under test is the teardown.
		await expect(send).rejects.toThrow(/request deadline exceeded|send timed out/);
		expect(sessions).toHaveLength(1);
		const session = sessions[0];
		expect(session.commands.at(-1)).toBe('DATA'); // torn down awaiting the 354
		await session.ended; // the socket really died — no lingering session
		expect(session.data).toBe(''); // the body was never consumed server-side
	});

	test('a mid-DATA teardown drains the stall timers with the session', async () => {
		stallDataMs = 600;
		const send = sendProtonMailEmail(MESSAGE, Date.now() + 300);
		await expect(send).rejects.toThrow(/request deadline exceeded|send timed out/);
		expect(sessions).toHaveLength(1);
		await sessions[0].ended;
		// The close hook cleared both pending callbacks — nothing stays armed
		// to retain the session closure or fire against dead sockets.
		expect(sessions[0].stallTimersDrained).toBe(true);
		// Outlast the armed stall: a callback that survived clearTimeout
		// would have flipped stallFired by now (gitar).
		await new Promise((resolve) => setTimeout(resolve, stallDataMs + 150));
		expect(sessions[0].stallFired).toBe(false);
	});
});


test('passes a validated Reply-To and stable Message-ID to SMTP', async () => {
	await sendProtonMailEmail({ ...MESSAGE, replyTo: 'visitor@example.com', messageId: '<moderaty-contact-12@moderaty.com>' });
	expect(mocks.sendMail.mock.calls[0][0]).toMatchObject({ replyTo: 'visitor@example.com', messageId: '<moderaty-contact-12@moderaty.com>' });
});

test.each(['a@example.com\r\nBcc: evil@example.com', 'a@example.com,b@example.com', 'Name <a@example.com>', '', 123])('rejects unsafe Reply-To %s before connecting', async (replyTo) => {
	await expect(sendProtonMailEmail({ ...MESSAGE, replyTo } as never)).rejects.toThrow(/reply-to/i);
	expect(mocks.createTransport).not.toHaveBeenCalled();
});

test.each(['bad\r\nBcc: a@example.com', 'not-a-message-id', '', 123])('rejects unsafe Message-ID %s before connecting', async (messageId) => {
	await expect(sendProtonMailEmail({ ...MESSAGE, messageId } as never)).rejects.toThrow(/message-id/i);
	expect(mocks.createTransport).not.toHaveBeenCalled();
});

test('a caller-limited guard remains a deadline when timer scheduling and the wall clock differ', async () => {
	vi.useFakeTimers();
	const now = Date.now();
	vi.spyOn(Date, 'now').mockReturnValue(now);
	mocks.sendMail.mockReturnValue(new Promise(() => {}));
	const send = sendProtonMailEmail(MESSAGE, now + 300);
	const assertion = expect(send).rejects.toBeInstanceOf(DeadlineExceededError);
	await vi.advanceTimersByTimeAsync(301);
	await assertion;
	expect(mocks.close).toHaveBeenCalled();
});

test.each([
 ['authentication', { code: 'EAUTH', command: 'AUTH PLAIN' }, 'retryable'],
 ['phase-ambiguous CONN disconnect', { code: 'ECONNECTION', command: 'CONN' }, 'unknown'],
 ['throttled DATA', { code: 'EMESSAGE', responseCode: 451, command: 'DATA' }, 'retryable'],
 ['rejected DATA', { code: 'EMESSAGE', responseCode: 550, command: 'DATA' }, 'permanent'],
 ['disconnect during DATA', { code: 'ECONNECTION', command: 'DATA' }, 'unknown'],
 ['unclassified disconnect', { code: 'ESOCKET' }, 'unknown']
])('exposes a sanitized submission outcome for %s', async (_name, cause, outcome) => {
 mocks.sendMail.mockRejectedValueOnce(cause);
 await expect(sendProtonMailEmail(MESSAGE)).rejects.toMatchObject({ outcome, category: expect.any(String) });
});

test('an already-spent caller deadline is definitely not submitted', async () => {
 await expect(sendProtonMailEmail(MESSAGE, Date.now() - 1)).rejects.toMatchObject({ outcome: 'retryable', category: 'deadline_before_submission' });
 expect(mocks.sendMail).not.toHaveBeenCalled();
});


test('an expired deadline takes precedence over missing configuration and invalid message input', async () => {
 delete mocks.env.PROTON_SMTP_TOKEN;
 await expect(sendProtonMailEmail({ ...MESSAGE, toEmail: 'invalid' }, Date.now() - 1)).rejects.toMatchObject({ outcome: 'retryable', category: 'deadline_before_submission' });
 expect(mocks.sendMail).not.toHaveBeenCalled();
});

test('malformed SMTP response codes cannot become definite rejections', async () => {
 mocks.sendMail.mockRejectedValueOnce({ code: 'ESOCKET', responseCode: NaN });
 await expect(sendProtonMailEmail(MESSAGE)).rejects.toMatchObject({ outcome: 'unknown' });
});
