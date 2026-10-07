// Proton Mail SMTP submission client — Nodemailer over mandatory STARTTLS to
// smtp.protonmail.ch:587 (proton.me/support/smtp-submission). Nodemailer is
// the maintainer-approved exception to the no-SDK dependency policy (MOD-116)
// and is server-only — never import it into client code. Auth uses the
// account's dedicated SMTP token (PLAIN/LOGIN), never the mailbox password
// and never Proton Mail Bridge.

import { Socket } from 'node:net';

import { env } from '$env/dynamic/private';

import nodemailer from 'nodemailer';

import { DeadlineExceededError } from './http';

const PROTON_SMTP_HOST = 'smtp.protonmail.ch';
const PROTON_SMTP_PORT = 587;
const PROTON_TIMEOUT_MS = 10_000;
const DEFAULT_FROM_NAME = 'Moderaty';

// Envelope/header injection guard: a bare mailbox only — no whitespace
// (covers CR/LF folding), no control characters, and none of the
// address-list or display-name vectors (`,` `;` `<` `>` `"` `(` `)` `[` `]`
// `\` `:`). An apostrophe is legal in an RFC local part and stays allowed —
// the /contact form accepts it (codex+cubic). Deliberately stricter than
// the form's EMAIL_PATTERN, whose `[^\s@]` still admits `a,b@example.com`.
const BARE_ADDRESS = /^[^\s@,;:<>"()[\]\\\x00-\x1f\x7f]+@[^\s@,;:<>"()[\]\\\x00-\x1f\x7f]+$/i;

/**
 * True when `email` is a single bare mailbox this transport will accept —
 * the shared contract the /contact form enforces at validation time, so a
 * submitted address can never fail the send with a 500 (codex).
 */
export function isBareAddress(email: string): boolean {
	return email.length > 0 && email.length <= 254 && BARE_ADDRESS.test(email);
}

// Any value that lands inside an SMTP header line (subject, display names)
// must not carry control characters — folding is where header injection
// lives. Message bodies legitimately contain newlines and are never checked
// by this guard.
const HEADER_UNSAFE = /[\x00-\x1f\x7f]/;

/** Marker for our own whole-operation guard firing (not a provider error). */
class SendGuardExpiredError extends Error {}

/** Configuration-only diagnostics are fixed strings safe for server logs. */
export class ProtonMailConfigurationError extends Error {}

/** Scheduling failure proven to occur before sendMail is invoked. */
export class ProtonMailPreSubmissionDeadlineError extends DeadlineExceededError {
	readonly outcome = 'retryable';
	readonly category = 'deadline_before_submission';
}

/** Safe, machine-readable SMTP outcome; never contains a provider reply or recipient. */
export class ProtonMailSubmissionError extends Error {
	constructor(
		public readonly outcome: 'retryable' | 'permanent' | 'unknown',
		public readonly category: string,
		message: string
	) { super(message); }
}

export interface ProtonMailConfig {
	username: string;
	token: string;
	fromName: string;
}

/**
 * Reads the Proton Mail SMTP configuration from the environment, failing
 * loudly at handler start (never at import) when a required key is missing.
 * The username is also the From address, so it must be a bare mailbox — a
 * malformed one would corrupt the sender header (I2).
 *
 * @returns The validated credentials and sender identity.
 */
export function loadProtonMailConfig(): ProtonMailConfig {
	const username = env.PROTON_SMTP_USERNAME;
	const token = env.PROTON_SMTP_TOKEN;
	if (!username) throw new ProtonMailConfigurationError('PROTON_SMTP_USERNAME is not configured');
	if (!token) throw new ProtonMailConfigurationError('PROTON_SMTP_TOKEN is not configured');
	if (!isBareAddress(username)) throw new ProtonMailConfigurationError('PROTON_SMTP_USERNAME must be a bare e-mail address');
	const fromName = env.PROTON_FROM_NAME?.trim() || DEFAULT_FROM_NAME;
	if (HEADER_UNSAFE.test(fromName)) throw new ProtonMailConfigurationError('PROTON_FROM_NAME must not contain control characters');
	return { username, token, fromName };
}

export interface ProtonMailMessage {
	toEmail: string;
	replyTo?: string;
	messageId?: string;
	subject: string;
	textPart: string;
	htmlPart: string;
}

export interface ProtonMailSendResult {
	messageId: string;
}

/**
 * Boundary validation for everything the caller controls. Runs before any
 * connection is opened: the recipient must be a single bare mailbox (no
 * lists, no display name, no CR/LF injection), the subject must be a
 * header-safe line, and both body parts must be present.
 */
function validateMessage(message: ProtonMailMessage): void {
	if (message.replyTo !== undefined && (typeof message.replyTo !== 'string' || !isBareAddress(message.replyTo))) {
		throw new Error('e-mail could not be sent (invalid reply-to address)');
	}
	if (message.messageId !== undefined && (typeof message.messageId !== 'string' || !/^<[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+>$/.test(message.messageId))) {
		throw new Error('e-mail could not be sent (invalid message-id)');
	}
	if (typeof message.toEmail !== 'string' || !isBareAddress(message.toEmail)) {
		throw new Error('e-mail could not be sent (invalid recipient address)');
	}
	if (typeof message.subject !== 'string' || message.subject.length === 0 || HEADER_UNSAFE.test(message.subject)) {
		throw new Error('e-mail could not be sent (invalid subject)');
	}
	if (
		typeof message.textPart !== 'string' ||
		message.textPart.length === 0 ||
		typeof message.htmlPart !== 'string' ||
		message.htmlPart.length === 0
	) {
		throw new Error('e-mail could not be sent (missing body part)');
	}
}

/** Extracts the bare mailbox from an accepted/rejected entry (string or parsed address object). */
function addressText(entry: unknown): string {
	if (typeof entry === 'string') return entry;
	const address = (entry as { address?: unknown } | null)?.address;
	return typeof address === 'string' ? address : '';
}

/**
 * Acceptance is proven by the envelope verdicts and the final DATA response
 * — never by a generated Message-ID, which Nodemailer assigns before the
 * server answers (I1/I2). Returns the message id only after the intended
 * recipient is the sole accepted envelope, nothing was rejected, and the
 * server closed DATA with a 250.
 */
function validatedMessageId(info: unknown, toEmail: string): string {
	const verdict = (info ?? {}) as { accepted?: unknown; rejected?: unknown; response?: unknown; messageId?: unknown };
	const rejected = Array.isArray(verdict.rejected) ? verdict.rejected : [];
	if (rejected.length > 0) {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.error('proton mail send failed: server rejected the recipient');
		throw new ProtonMailSubmissionError('permanent', 'recipient_rejected', 'e-mail could not be sent (recipient rejected)');
	}
	const accepted = Array.isArray(verdict.accepted) ? verdict.accepted : [];
	const soleRecipient =
		accepted.length === 1 && addressText(accepted[0]).toLowerCase() === toEmail.toLowerCase();
	const finalResponse = typeof verdict.response === 'string' ? verdict.response : '';
	if (!soleRecipient || !/^250[\s-]/.test(finalResponse)) {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.error('proton mail send failed: malformed acceptance (recipient or DATA verdict missing)');
		throw new ProtonMailSubmissionError('unknown', 'malformed_acceptance', 'e-mail could not be sent (malformed acceptance)');
	}
	if (typeof verdict.messageId !== 'string' || verdict.messageId.length === 0) {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.error('proton mail send failed: acceptance carried no message id');
		throw new ProtonMailSubmissionError('unknown', 'malformed_acceptance', 'e-mail could not be sent (malformed acceptance)');
	}
	return verdict.messageId;
}

/** An explicit negative SMTP response proves non-acceptance, including DATA. */
function smtpRejection(responseCode: number | undefined): ProtonMailSubmissionError | null {
	if (responseCode === undefined || !Number.isFinite(responseCode) || responseCode < 400) return null;
	if (responseCode < 500) return new ProtonMailSubmissionError('retryable', 'throttled', 'e-mail could not be sent (provider throttled the request)');
	return new ProtonMailSubmissionError('permanent', 'rejected', 'e-mail could not be sent (provider rejected the request)');
}

/**
 * Maps a Nodemailer/SMTP failure to a generic client-safe error and logs
 * sanitized diagnostics (error code, numeric response code, command name)
 * — never the token, message bodies, links, or the server's raw reply text.
 */
function smtpFailure(error: unknown): Error {
	const detail = (error ?? {}) as { code?: unknown; responseCode?: unknown; command?: unknown };
	const code = typeof detail.code === 'string' ? detail.code : undefined;
	const responseCode = typeof detail.responseCode === 'number' ? detail.responseCode : undefined;
	const command = typeof detail.command === 'string' ? detail.command : undefined;
	// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
	console.error('proton mail send failed:', JSON.stringify({ code, responseCode, command }));
	const failure = (outcome: 'retryable' | 'permanent' | 'unknown', category: string, message: string) =>
		new ProtonMailSubmissionError(outcome, category, `e-mail could not be sent (${message})`);
	if (code === 'EAUTH') return failure('retryable', 'authentication', 'authentication failure');
	if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEOUT') return failure('unknown', 'timeout', 'send timed out');
	// MAIL FROM is configured deployment identity; only RCPT TO failures
	// concern the recipient. A sender rejection must pause the campaign.
	if (code === 'EENVELOPE' && command?.toUpperCase() === 'MAIL FROM') return failure('retryable', 'sender_rejected', 'sender rejected');
	if (code === 'EENVELOPE') return failure(responseCode !== undefined && responseCode < 500 ? 'retryable' : 'permanent', 'recipient_rejected', 'recipient rejected');
	if (code !== undefined && /CERT|TLS|SSL|ALTNAME|SELF_SIGNED|UNABLE_TO/i.test(code)) {
		return failure('retryable', 'tls', 'TLS failure');
	}
	const rejection = smtpRejection(responseCode);
	if (rejection) return rejection;
	if (code === 'EDNS') return failure('retryable', 'dns', 'SMTP failure');
	// Nodemailer reports CONN for socket closes after DATA too: it is NOT
	// proof of a pre-submission failure. Only known pre-submission phases
	// are safe to retry. Missing phase information may mean DATA was accepted.
	const beforeSubmission = command !== undefined && /^(EHLO|HELO|STARTTLS|AUTH(?: .*)?|MAIL FROM|RCPT TO)$/i.test(command);
	return failure(beforeSubmission ? 'retryable' : 'unknown', 'smtp', 'SMTP failure');
}

/**
 * Sends one e-mail through Proton Mail's SMTP submission endpoint.
 *
 * Fails loudly on every failure mode — missing env, unsafe input, auth or
 * TLS failure, connection error, timeout, recipient/DATA rejection, or a
 * malformed acceptance — with a generic client-safe message while sanitized
 * diagnostic codes go to the server log (AGENTS.md: never surface raw
 * third-party responses to the client). No retries and no fallback send: a
 * crashed or ambiguous attempt is reconciled by the caller's own retry
 * logic (the contact form's resubmission, the sweep's claim release).
 *
 * @param message - The bare recipient, subject, and text/HTML parts.
 * @param deadline - Optional absolute budget; expiry throws DeadlineExceededError.
 * @returns The provider-accepted message id.
 */
export async function sendProtonMailEmail(message: ProtonMailMessage, deadline?: number): Promise<ProtonMailSendResult> {
	if (deadline !== undefined && Date.now() >= deadline) throw new ProtonMailPreSubmissionDeadlineError();
	const config = loadProtonMailConfig();
	validateMessage(message);
	// The caller's run budget composes with (never widens) the 10s client
	// timeout; a spent budget surfaces as DeadlineExceededError so the sweep
	// defers instead of counting a provider failure (http.ts convention).
	const timeoutMs =
		deadline === undefined ? PROTON_TIMEOUT_MS : Math.min(PROTON_TIMEOUT_MS, deadline - Date.now());
	if (timeoutMs <= 0) throw new ProtonMailPreSubmissionDeadlineError();

	// Per-send transport — no pooling (MOD-116). secure:false + requireTLS
	// means STARTTLS is mandatory: the send fails rather than authenticating
	// on a plaintext socket, and Node's default CA verification stays on.
	// A non-pooled transport's close() only emits 'close' — it cannot reach
	// the live SMTPConnection, and a getSocket {socket} result is dropped
	// unless it is a proxy `connection` (MOD-238, verified against
	// nodemailer 10.0.10). Passing the socket through the documented
	// `socket` connection option makes SMTPConnection itself drive
	// .connect() on this handle, so the guard can always destroy the real
	// session socket — the STARTTLS upgrade wraps it in a TLSSocket that
	// shares the same fd.
	const smtpSocket = new Socket();
	const transport = nodemailer.createTransport({
		host: PROTON_SMTP_HOST,
		port: PROTON_SMTP_PORT,
		secure: false,
		requireTLS: true,
		auth: { user: config.username, pass: config.token },
		// Phase timeouts share the whole-operation budget but do not replace
		// it — the guard timer below is the hard cap and tears the socket down.
		connectionTimeout: timeoutMs,
		greetingTimeout: timeoutMs,
		socketTimeout: timeoutMs,
		dnsTimeout: timeoutMs,
		tls: { rejectUnauthorized: true },
		socket: smtpSocket
	});

	// Setup is synchronous but the budget can still be spent between the
	// pre-check above and here — recheck so an exhausted caller deadline
	// never opens an SMTP connection (cubic).
	if (deadline !== undefined && Date.now() >= deadline) {
		smtpSocket.destroy();
		transport.close();
		throw new ProtonMailPreSubmissionDeadlineError();
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_, reject) => {
		// Arm with the budget remaining NOW — transport setup already consumed
		// part of the caller's deadline since timeoutMs was computed at entry;
		// a stale entry-time value would let the send outlive the deadline.
		const callerBudget = deadline === undefined ? Infinity : deadline - Date.now();
		const guardMs = Math.min(timeoutMs, callerBudget);
		// Classify the bound that armed the timer. Timer scheduling and the
		// wall clock can differ at the boundary; a caller-limited guard must
		// still defer rather than be mislabeled as an SMTP failure.
		const guardError = callerBudget <= timeoutMs ? new DeadlineExceededError() : new SendGuardExpiredError();
		timer = setTimeout(() => {
			// Destroy the real socket BEFORE rejecting so an in-flight DATA
			// acceptance can never outlive the budget; the send's late
			// settlement is swallowed by the race (handled, ignored).
			smtpSocket.destroy();
			try {
				transport.close();
			} catch {
				// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
				console.error('proton mail: transport close failed during timeout teardown');
			}
			reject(guardError);
		}, guardMs);
	});

	let info: unknown;
	try {
		// No caller AbortSignal exists in this contract, so there is nothing
		// to compose (I5) — the absolute deadline is the only caller budget.
		info = await Promise.race([
			transport.sendMail({
				from: { name: config.fromName, address: config.username },
				to: message.toEmail,
				...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
				...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
				subject: message.subject,
				text: message.textPart,
				html: message.htmlPart
			}),
			guard
		]);
	} catch (error) {
		// A spent caller budget is a scheduling condition, not a provider
		// failure — keep it distinguishable so callers can defer cleanly.
		if (error instanceof DeadlineExceededError) throw error;
		if (deadline !== undefined && Date.now() >= deadline) throw new DeadlineExceededError();
		if (error instanceof SendGuardExpiredError) {
			// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
			console.error('proton mail send failed: operation timed out');
			throw new ProtonMailSubmissionError('unknown', 'timeout', 'e-mail could not be sent (send timed out)');
		}
		throw smtpFailure(error);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		smtpSocket.destroy();
		transport.close();
	}
	if (deadline !== undefined && Date.now() >= deadline) {
		// The provider already accepted the message — a confirmed side effect
		// must not be reported as a deferral, which would resend the delivered
		// mail (codex). Only an unconfirmed or malformed result degrades to
		// the deferral; validatedMessageId already logged its diagnostic.
		try {
			return { messageId: validatedMessageId(info, message.toEmail) };
		} catch {
			throw new DeadlineExceededError();
		}
	}
	return { messageId: validatedMessageId(info, message.toEmail) };
}
