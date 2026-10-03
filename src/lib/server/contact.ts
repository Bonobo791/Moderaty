// Opt-in contact flow (the public /contact form). A submission is recorded
// PENDING with its exact consent sentence BEFORE the verification e-mail is
// sent (I3: DB before remote — a crash between the two is recovered by
// resubmitting, which reuses the pending row); the e-mail link flips it to
// VERIFIED. Resubmission for the same address reuses the unexpired pending
// row and re-sends, so retries are idempotent (I4) and never duplicate rows.

import { randomBytes } from 'node:crypto';

import { env } from '$env/dynamic/private';

import { and, eq, gt } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { contactSubmissions } from '$lib/server/db/schema';
import { escapeHtml } from './emailText';
import { deliverContactNotification } from './contactNotification';
import { isBareAddress, sendProtonMailEmail } from './protonMail';

/**
 * The exact opt-in checkbox sentence, shown on the form and stored verbatim
 * on every submission row — the form cannot drift from what was agreed
 * (consents pattern). Passed to the page through the load function.
 */
export const CONTACT_OPT_IN_TEXT =
	'Yes, contact me at this e-mail address — I agree that Moderaty stores and processes my name, e-mail, and optional message to respond to my request.';

/** Verification link TTL: 7 days, matching invite links. */
export const CONTACT_VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_NAME_LENGTH = 200;
export const MAX_MESSAGE_LENGTH = 2000;

// Deliberately simple RFC-5322-ish shape check: no zod (banned), and the
// real gate is the verification e-mail itself — a wrong address simply never
// confirms. The /^[^\s@]+@[^\s@]+\.[^\s@]+$/ check rejects whitespace,
// missing @, missing domain dot, and empty parts. isBareAddress (the mail
// transport's contract) rejects envelope/header-unsafe forms — a submitted
// address must never be accepted here only to fail the send later (codex).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ContactParse =
	| { ok: true; name: string; email: string; message: string | null }
	| { ok: false; error: string; name: string; email: string; message: string };

/**
 * Validates the /contact form payload (name, e-mail, explicit opt-in box).
 * Returns the trimmed, normalized values on success, or a client-safe error
 * plus the submitted values (for re-rendering the form) on failure.
 *
 * @param form - The submitted FormData.
 * @returns The parsed submission or a field error.
 */
export function parseContactForm(form: FormData): ContactParse {
	const name = String(form.get('name') ?? '').trim();
	const email = String(form.get('email') ?? '').trim();
	const messages = form.getAll('message');
	const rawMessage = messages[0] ?? null;
	// Browsers serialize textarea line breaks as CRLF; count/store the same
	// LF characters that maxlength counts in the textarea.
	const message = typeof rawMessage === 'string' ? rawMessage.replace(/\r\n?/g, '\n') : '';
	if (messages.length > 1 || (rawMessage !== null && typeof rawMessage !== 'string')) {
		return { ok: false, error: 'Please enter your message as text.', name, email, message };
	}
	if (message.length > MAX_MESSAGE_LENGTH) {
		return { ok: false, error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`, name, email, message };
	}
	if (form.get('opt_in') !== 'on') {
		return { ok: false, error: 'You must tick the opt-in box to be contacted.', name, email, message };
	}
	if (name.length === 0) {
		return { ok: false, error: 'Please enter your name.', name, email, message };
	}
	if (name.length > MAX_NAME_LENGTH) {
		return { ok: false, error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`, name, email, message };
	}
	if (email.length === 0 || email.length > 254 || !EMAIL_PATTERN.test(email) || !isBareAddress(email)) {
		return { ok: false, error: 'Please enter a valid e-mail address.', name, email, message };
	}
	return { ok: true, name, email: email.toLowerCase(), message: message.trim() ? message : null };
}

export interface ContactSubmission {
	id: number;
	email: string;
	name: string;
	verificationToken: string;
	expiresAt: string;
	reused: boolean;
}

/**
 * Creates a PENDING submission row, or reuses the unexpired pending row for
 * the same e-mail (refreshing name/consent evidence and sliding the expiry
 * so a resubmission — e.g. after a failed send — re-sends the same link).
 *
 * The e-mail is normalized here as well as in parseContactForm (I2 — validate
 * at every boundary): every caller stores and dedupes on the same canonical
 * form.
 *
 * @param input - The validated submission data and consent evidence.
 * @returns The pending submission row.
 */
export async function createOrReusePendingSubmission(input: {
	name: string;
	email: string;
	message?: string | null;
	consentText: string;
	ip: string;
	userAgent: string;
}): Promise<ContactSubmission> {
	const email = input.email.trim().toLowerCase();
	const expiresAt = new Date(Date.now() + CONTACT_VERIFICATION_TTL_MS).toISOString();
	const token = randomBytes(32).toString('hex');

	// Bounded retry (human review): reusing the pending row can lose a race to
	// a concurrent verification (the winner stops being pending between the
	// read and the update), in which case the next pass inserts a fresh row.
	// The partial unique index keeps at most one pending row per e-mail, so
	// only a few genuine conflicts can ever occur.
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const now = new Date();
		const existing = await db
			.select()
			.from(contactSubmissions)
			.where(
				and(
					eq(contactSubmissions.email, email),
					eq(contactSubmissions.status, 'pending'),
					gt(contactSubmissions.expiresAt, now.toISOString())
				)
			)
			.get();
		if (existing) {
			const reused = await refreshPendingSubmission(email, input, expiresAt);
			if (reused) return reused;
			continue; // verified between the read and the update — retry fresh
		}
		try {
			const inserted = await db
				.insert(contactSubmissions)
				.values({
					email,
					name: input.name,
					message: input.message ?? null,
					status: 'pending',
					verificationToken: token,
					expiresAt,
					consentText: input.consentText,
					ip: input.ip,
					userAgent: input.userAgent
				})
				.returning();
			return {
				id: inserted[0].id,
				email: inserted[0].email,
				name: inserted[0].name,
				verificationToken: token,
				expiresAt,
				reused: false
			};
		} catch (error) {
			// Idempotency (human review): the partial unique index on
			// (email) WHERE status='pending' makes a concurrent submission's insert
			// conflict instead of silently creating a second row with a different
			// token (two verification e-mails). Converge on the one pending row —
			// an expired one is fine: submitContactRequest re-sends the e-mail and
			// the expiry below slides, so the resubmission gets a working link.
			if (!isUniqueViolation(error)) throw error;
			const reused = await refreshPendingSubmission(email, input, expiresAt);
			if (reused) {
				// A concurrent-insert conflict is a real server event: log the
				// race so operators can see it (never a silent fallback).
				console.warn('[contact] pending submission insert conflicted; reusing the existing pending row');
				return reused;
			}
			// The winner was verified between the conflict and the reuse update —
			// loop to create a fresh pending row instead of returning a used token.
		}
	}
	throw new Error('could not create a pending contact submission after repeated conflicts');
}

/**
 * Refreshes and returns the still-pending row for an e-mail atomically: the
 * update only matches `status = 'pending'`, so a row verified (or removed)
 * between the caller's read and this update matches nothing and null is
 * returned — the caller then creates a fresh pending row instead of reusing a
 * verification token that is no longer usable.
 */
async function refreshPendingSubmission(
	email: string,
	input: { name: string; message?: string | null; consentText: string; ip: string; userAgent: string },
	expiresAt: string
): Promise<ContactSubmission | null> {
	const updated = await db
		.update(contactSubmissions)
		.set({ name: input.name, message: input.message ?? null, consentText: input.consentText, ip: input.ip, userAgent: input.userAgent, expiresAt })
		.where(and(eq(contactSubmissions.email, email), eq(contactSubmissions.status, 'pending')))
		.returning();
	const row = updated[0];
	if (!row) return null;
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		verificationToken: row.verificationToken,
		expiresAt,
		reused: true
	};
}

/** Whether an insert error is the partial-unique-index violation (SQLite). */
export function isUniqueViolation(error: unknown): boolean {
	// The libsql client wraps the constraint error: the drizzle statement
	// error's message is 'Failed query: …' with the LibsqlError (code
	// SQLITE_CONSTRAINT*, message 'UNIQUE constraint failed: …') on the
	// cause chain. Walk the chain and match either surface. The walk is
	// bounded so a cause cycle that does not include the original error
	// (b.cause = c, c.cause = b) cannot spin a request thread forever.
	let current: unknown = error;
	for (let depth = 0; current && depth < 10; depth += 1) {
		const record = current as { code?: unknown; message?: unknown };
		if (typeof record.code === 'string' && /SQLITE_CONSTRAINT_UNIQUE/i.test(record.code)) return true;
		if (typeof record.message === 'string' && /UNIQUE constraint failed/i.test(record.message)) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

export type ContactVerificationResult =
	| { status: 'pending'; email: string }
	| { status: 'verified'; email: string }
	| { status: 'already_verified'; email: string }
	| { status: 'delivery_pending'; email: string }
	| { status: 'expired'; email: string }
	| { status: 'invalid' };

/** Reads a verification link without accepting consent or sending mail. */
export async function getContactVerificationStatus(token: string): Promise<ContactVerificationResult> {
	const row = await db.select().from(contactSubmissions)
		.where(eq(contactSubmissions.verificationToken, token)).get();
	if (!row) return { status: 'invalid' };
	if (row.status === 'verified') {
		return { status: row.notificationDueAt !== null && row.notificationSentAt === null ? 'delivery_pending' : 'already_verified', email: row.email };
	}
	return { status: Date.parse(row.expiresAt) <= Date.now() ? 'expired' : 'pending', email: row.email };
}

/**
 * Marks a submission verified when its token is valid, unexpired, and not
 * yet used. Idempotent (I4): re-opening an already-verified link reports
 * 'already_verified' instead of failing, and unknown tokens are 'invalid'.
 *
 * @param token - The verification token from the e-mail link.
 * @returns The outcome and the verified e-mail address (when known).
 */
export async function verifyContactToken(token: string): Promise<ContactVerificationResult> {
	const now = new Date().toISOString();
	// Queue in the same write as verification. The conditional update fences
	// concurrent clicks and never re-queues historical/already verified rows.
	const verified = await db.update(contactSubmissions)
		.set({ status: 'verified', verifiedAt: now, notificationDueAt: now })
		.where(and(
			eq(contactSubmissions.verificationToken, token),
			eq(contactSubmissions.status, 'pending'),
			gt(contactSubmissions.expiresAt, now)
		)).returning({ id: contactSubmissions.id });
	const row = await db.select().from(contactSubmissions)
		.where(eq(contactSubmissions.verificationToken, token)).get();
	if (!row) return { status: 'invalid' };
	if (row.status !== 'verified') return { status: 'expired', email: row.email };
	if (row.notificationDueAt !== null && row.notificationSentAt === null) {
		try {
			const delivery = await deliverContactNotification(row.id);
			if (delivery === 'deferred') return { status: 'delivery_pending', email: row.email };
		} catch {
			// Verified data is durable. Show the retry state instead of claiming
			// the request has reached the inbox while SMTP is unavailable.
			console.error('[contact] verified request awaiting notification', { id: row.id });
			return { status: 'delivery_pending', email: row.email };
		}
	}
	return { status: verified.length ? 'verified' : 'already_verified', email: row.email };
}

export interface VerificationEmail {
	subject: string;
	textPart: string;
	htmlPart: string;
}

/**
 * Builds the verification e-mail content around the confirmation link.
 *
 * @param input - The recipient's name and the absolute verification URL.
 * @returns The subject and text/HTML parts.
 */
export function buildVerificationEmail(input: { name: string; verifyUrl: string }): VerificationEmail {
	const subject = 'Confirm your contact request — Moderaty';
	const textPart = [
		`Hi ${input.name},`,
		'',
		'Someone (hopefully you) asked Moderaty to contact them using this e-mail address.',
		'',
		`Open this link, then choose Confirm contact request: ${input.verifyUrl}`,
		'',
		'The link is valid for 7 days. If you did not submit this request, ignore this e-mail.',
		'',
		'— Moderaty'
	].join('\n');
	const htmlPart = [
		`<p>Hi ${escapeHtml(input.name)},</p>`,
		'<p>Someone (hopefully you) asked Moderaty to contact them using this e-mail address.</p>',
		['<p>Open this link, then choose Confirm contact request: <a href="', escapeHtml(input.verifyUrl), '">', escapeHtml(input.verifyUrl), '</a></p>'].join(''),
		'<p>The link is valid for 7 days. If you did not submit this request, ignore this e-mail.</p>',
		'<p>— Moderaty</p>'
	].join('');
	return { subject, textPart, htmlPart };
}

/**
 * Records a pending submission and sends the verification e-mail. The row is
 * written FIRST (I3): if the send fails, the error propagates to the caller
 * (which fails loudly) and the pending row is reused by the next attempt.
 *
 * @param input - The validated submission data and consent evidence.
 * @returns The submission plus the verification URL that was e-mailed.
 */
export async function submitContactRequest(input: {
	name: string;
	email: string;
	message?: string | null;
	consentText: string;
	ip: string;
	userAgent: string;
}): Promise<ContactSubmission & { verifyUrl: string }> {
	const appUrl = env.APP_URL;
	if (!appUrl) throw new Error('APP_URL is not configured');
	const submission = await createOrReusePendingSubmission(input);
	const verifyUrl = new URL('/contact/verify', appUrl);
	verifyUrl.searchParams.set('token', submission.verificationToken);
	const email = buildVerificationEmail({ name: submission.name, verifyUrl: verifyUrl.toString() });
	await sendProtonMailEmail({
		toEmail: submission.email,
		subject: email.subject,
		textPart: email.textPart,
		htmlPart: email.htmlPart
	});
	return { ...submission, verifyUrl: verifyUrl.toString() };
}
