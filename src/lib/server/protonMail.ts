// Proton Mail SMTP submission client — Nodemailer over mandatory STARTTLS to
// smtp.protonmail.ch:587 (proton.me/support/smtp-submission). Nodemailer is
// the maintainer-approved exception to the no-SDK dependency policy (MOD-116)
// and is server-only — never import it into client code. Auth uses the
// account's dedicated SMTP token (PLAIN/LOGIN), never the mailbox password
// and never Proton Mail Bridge.

import { Socket } from 'node:net';

import { env } from '$env/dynamic/private';

import nodemailer from 'nodemailer';

import { assertBeforeDeadline, DeadlineExceededError } from './http';

const PROTON_SMTP_HOST = 'smtp.protonmail.ch';
const PROTON_SMTP_PORT = 587;
const PROTON_TIMEOUT_MS = 10_000;
const DEFAULT_FROM_NAME = 'Moderaty';

// Envelope/header injection guard: a bare mailbox only — no whitespace
// (covers CR/LF folding), no control characters, and none of the
// address-list or display-name vectors (`,` `;` `<` `>` `"` `(` `)` `[` `]`
// `\` `:`). `'` stays legal — it is a valid RFC 5321 local-part character
// (`o'connor@…`), and a quoted-pair display name never reaches this point.
// Deliberately stricter than the /contact form's EMAIL_PATTERN, whose
// `[^\s@]` still admits `a@b,c@d` lists — the form reuses
// `isSendableRecipient` so persisted rows can always be sent.
const BARE_ADDRESS = /^[^\s@,;<>"()[\]\\:\x00-\x1f\x7f]+@[^\s@,;<>"()[\]\\:\x00-\x1f\x7f]+$/i;

/** What the transport can put on the wire: one bare mailbox, length-bounded. */
export function isSendableRecipient(email: unknown): email is string {
	return typeof email === 'string' && email.length > 0 && email.length <= 254 && BARE_ADDRESS.test(email);
}

// Any value that lands inside an SMTP header line (subject, display names)
// must not carry control characters — folding is where header injection
// lives. Message bodies legitimately contain newlines and are never checked
// by this guard.
const HEADER_UNSAFE = /[\x00-\x1f\x7f]/;

/** Marker for our own whole-operation guard firing (not a provider error). */
class SendGuardExpiredError extends Error {}

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
	if (!username) throw new Error('PROTON_SMTP_USERNAME is not configured');
	if (!token) throw new Error('PROTON_SMTP_TOKEN is not configured');
	if (!BARE_ADDRESS.test(username)) throw new Error('PROTON_SMTP_USERNAME must be a bare e-mail address');
	const fromName = env.PROTON_FROM_NAME?.trim() || DEFAULT_FROM_NAME;
	if (HEADER_UNSAFE.test(fromName)) throw new Error('PROTON_FROM_NAME must not contain control characters');
	return { username, token, fromName };
}

export interface ProtonMailMessage {
	toEmail: string;
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
	if (!isSendableRecipient(message.toEmail)) {
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
 * Whether the provider verdict proves acceptance: the intended recipient is
 * the sole accepted envelope, nothing was rejected, DATA closed with a 250,
 * and a message id came back. Shared with the post-send deadline decision —
 * only this proof may skip the defer check.
 */
function acceptanceProven(info: unknown, toEmail: string): boolean {
	const verdict = (info ?? {}) as { accepted?: unknown; rejected?: unknown; response?: unknown; messageId?: unknown };
	const rejected = Array.isArray(verdict.rejected) ? verdict.rejected : [];
	const accepted = Array.isArray(verdict.accepted) ? verdict.accepted : [];
	const finalResponse = typeof verdict.response === 'string' ? verdict.response : '';
	return (
		rejected.length === 0 &&
		accepted.length === 1 &&
		addressText(accepted[0]).toLowerCase() === toEmail.toLowerCase() &&
		/^250[\s-]/.test(finalResponse) &&
		typeof verdict.messageId === 'string' &&
		verdict.messageId.length > 0
	);
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
		throw new Error('e-mail could not be sent (recipient rejected)');
	}
	const accepted = Array.isArray(verdict.accepted) ? verdict.accepted : [];
	const soleRecipient =
		accepted.length === 1 && addressText(accepted[0]).toLowerCase() === toEmail.toLowerCase();
	const finalResponse = typeof verdict.response === 'string' ? verdict.response : '';
	if (!soleRecipient || !/^250[\s-]/.test(finalResponse)) {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.error('proton mail send failed: malformed acceptance (recipient or DATA verdict missing)');
		throw new Error('e-mail could not be sent (malformed acceptance)');
	}
	if (typeof verdict.messageId !== 'string' || verdict.messageId.length === 0) {
		// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
		console.error('proton mail send failed: acceptance carried no message id');
		throw new Error('e-mail could not be sent (malformed acceptance)');
	}
	return verdict.messageId;
}

/**
 * Maps a Nodemailer/SMTP failure to a generic client-safe error and logs
 * sanitized diagnostics (error code, numeric response code, command name)
 * — never the token, message bodies, links, or the server's raw reply text.
 */
function smtpFailure(error: unknown): Error {
	const detail = (error ?? {}) as {
		code?: unknown;
		responseCode?: unknown;
		command?: unknown;
		response?: unknown;
	};
	const code = typeof detail.code === 'string' ? detail.code : undefined;
	const responseCode = typeof detail.responseCode === 'number' ? detail.responseCode : undefined;
	const command = typeof detail.command === 'string' ? detail.command : undefined;
	// The server's SMTP reply text and the original error message stay in the
	// server log — without them two distinct provider failures sharing a code
	// are indistinguishable in production. Client-facing text stays generic.
	const response = typeof detail.response === 'string' ? detail.response : undefined;
	const message = error instanceof Error ? error.message : undefined;
	// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
	console.error('proton mail send failed:', JSON.stringify({ code, responseCode, command, response, message }));
	if (code === 'EAUTH') return new Error('e-mail could not be sent (authentication failure)');
	if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEOUT') return new Error('e-mail could not be sent (send timed out)');
	if (code === 'EENVELOPE') return new Error('e-mail could not be sent (recipient rejected)');
	if (code !== undefined && /CERT|TLS|SSL|ALTNAME|SELF_SIGNED|UNABLE_TO/i.test(code)) {
		return new Error('e-mail could not be sent (TLS failure)');
	}
	if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) {
		return new Error('e-mail could not be sent (provider throttled the request)');
	}
	if (responseCode !== undefined && responseCode >= 500) {
		return new Error('e-mail could not be sent (provider rejected the request)');
	}
	return new Error('e-mail could not be sent (SMTP failure)');
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
	const config = loadProtonMailConfig();
	validateMessage(message);
	// The caller's run budget composes with (never widens) the 10s client
	// timeout; a spent budget surfaces as DeadlineExceededError so the sweep
	// defers instead of counting a provider failure (http.ts convention).
	const timeoutMs =
		deadline === undefined ? PROTON_TIMEOUT_MS : Math.min(PROTON_TIMEOUT_MS, deadline - Date.now());
	if (timeoutMs <= 0) throw new DeadlineExceededError();

	// Per-send transport — no pooling (MOD-116). secure:false + requireTLS
	// means STARTTLS is mandatory: the send fails rather than authenticating
	// on a plaintext socket, and Node's default CA verification stays on.
	// The socket is injected and held: transport.close() on a non-pooled send
	// only emits 'close' and cannot cancel the in-flight SMTPConnection, so
	// the guard below must destroy the wire itself — a "timed out" send that
	// kept a live socket could still deliver, and the retry would duplicate
	// the mail.
	const socket = new Socket();
	const transport = nodemailer.createTransport({
		host: PROTON_SMTP_HOST,
		port: PROTON_SMTP_PORT,
		socket,
		secure: false,
		requireTLS: true,
		auth: { user: config.username, pass: config.token },
		// Phase timeouts share the whole-operation budget but do not replace
		// it — the guard timer below is the hard cap and tears the socket down.
		connectionTimeout: timeoutMs,
		greetingTimeout: timeoutMs,
		socketTimeout: timeoutMs,
		dnsTimeout: timeoutMs,
		tls: { rejectUnauthorized: true }
	});

	// Transport setup above took real time — re-verify the caller's budget
	// before arming anything so an expired deadline never starts SMTP, and arm
	// the guard with a fresh delay so it fires AT the deadline rather than
	// deadline + setup skew.
	assertBeforeDeadline(deadline);

	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_, reject) => {
		const guardMs = Math.max(0, Math.min(PROTON_TIMEOUT_MS, (deadline ?? Infinity) - Date.now()));
		timer = setTimeout(() => {
			// Destroy the held socket BEFORE rejecting so an in-flight DATA
			// acceptance can never outlive the budget; the send's late
			// settlement is swallowed by the race (handled, ignored).
			try {
				socket.destroy();
				transport.close();
			} catch {
				// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
				console.error('proton mail: transport close failed during timeout teardown');
			}
			reject(new SendGuardExpiredError());
		}, timeoutMs);
	});

	let info: unknown;
	try {
		// No caller AbortSignal exists in this contract, so there is nothing
		// to compose (I5) — the absolute deadline is the only caller budget.
		info = await Promise.race([
			transport.sendMail({
				from: { name: config.fromName, address: config.username },
				to: message.toEmail,
				subject: message.subject,
				text: message.textPart,
				html: message.htmlPart
			}),
			guard
		]);
	} catch (error) {
		// A spent caller budget is a scheduling condition, not a provider
		// failure — keep it distinguishable so callers can defer cleanly.
		if (deadline !== undefined && Date.now() >= deadline) throw new DeadlineExceededError();
		if (error instanceof SendGuardExpiredError) {
			// Stryker disable next-line StringLiteral: log-only message — mutating it changes no observable behavior
			console.error('proton mail send failed: operation timed out');
			throw new Error('e-mail could not be sent (send timed out)');
		}
		throw smtpFailure(error);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		socket.destroy();
		transport.close();
	}
	// A resolved sendMail with a proven 250 acceptance means the message
	// already left — a deadline that expired mid-return must not reclassify
	// delivered mail as deferrable (the caller would release its claim and
	// send a duplicate). Any other verdict keeps the old semantics: expired
	// deadline defers, otherwise the acceptance check fails loudly.
	if (!acceptanceProven(info, message.toEmail) && deadline !== undefined && Date.now() >= deadline) {
		throw new DeadlineExceededError();
	}
	return { messageId: validatedMessageId(info, message.toEmail) };
}
