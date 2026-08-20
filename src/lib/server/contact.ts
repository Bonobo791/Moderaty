// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

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
import { sendMailjetMessage } from './mailjet';

/**
 * The exact opt-in checkbox sentence, shown on the form and stored verbatim
 * on every submission row — the form cannot drift from what was agreed
 * (consents pattern). Passed to the page through the load function.
 */
export const CONTACT_OPT_IN_TEXT =
	'Yes, contact me at this e-mail address — I agree that Moderaty stores and processes my name and e-mail to respond to my request.';

/** Verification link TTL: 7 days, matching invite links. */
export const CONTACT_VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_NAME_LENGTH = 200;

// Deliberately simple RFC-5322-ish shape check: no zod (banned), and the
// real gate is the verification e-mail itself — a wrong address simply never
// confirms. The /^[^\s@]+@[^\s@]+\.[^\s@]+$/ check rejects whitespace,
// missing @, missing domain dot, and empty parts.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ContactParse =
	| { ok: true; name: string; email: string }
	| { ok: false; error: string; name: string; email: string };

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
	if (form.get('opt_in') !== 'on') {
		return { ok: false, error: 'You must tick the opt-in box to be contacted.', name, email };
	}
	if (name.length === 0) {
		return { ok: false, error: 'Please enter your name.', name, email };
	}
	if (name.length > MAX_NAME_LENGTH) {
		return { ok: false, error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`, name, email };
	}
	if (email.length === 0 || email.length > 254 || !EMAIL_PATTERN.test(email)) {
		return { ok: false, error: 'Please enter a valid e-mail address.', name, email };
	}
	return { ok: true, name, email: email.toLowerCase() };
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
	input: { name: string; consentText: string; ip: string; userAgent: string },
	expiresAt: string
): Promise<ContactSubmission | null> {
	const updated = await db
		.update(contactSubmissions)
		.set({ name: input.name, consentText: input.consentText, ip: input.ip, userAgent: input.userAgent, expiresAt })
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
	| { status: 'verified'; email: string }
	| { status: 'already_verified'; email: string }
	| { status: 'expired'; email: string }
	| { status: 'invalid' };

/**
 * Marks a submission verified when its token is valid, unexpired, and not
 * yet used. Idempotent (I4): re-opening an already-verified link reports
 * 'already_verified' instead of failing, and unknown tokens are 'invalid'.
 *
 * @param token - The verification token from the e-mail link.
 * @returns The outcome and the verified e-mail address (when known).
 */
export async function verifyContactToken(token: string): Promise<ContactVerificationResult> {
	const row = await db
		.select()
		.from(contactSubmissions)
		.where(eq(contactSubmissions.verificationToken, token))
		.get();
	if (!row) return { status: 'invalid' };
	if (row.status === 'verified') return { status: 'already_verified', email: row.email };
	if (Date.parse(row.expiresAt) <= Date.now()) return { status: 'expired', email: row.email };
	await db
		.update(contactSubmissions)
		.set({ status: 'verified', verifiedAt: new Date().toISOString() })
		.where(eq(contactSubmissions.id, row.id));
	return { status: 'verified', email: row.email };
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
		`Confirm your e-mail address by opening this link: ${input.verifyUrl}`,
		'',
		'The link is valid for 7 days. If you did not submit this request, ignore this e-mail.',
		'',
		'— Moderaty'
	].join('\n');
	const htmlPart = [
		`<p>Hi ${escapeHtml(input.name)},</p>`,
		'<p>Someone (hopefully you) asked Moderaty to contact them using this e-mail address.</p>',
		`<p>Confirm your e-mail address by opening this link: <a href="${escapeHtml(input.verifyUrl)}">${escapeHtml(input.verifyUrl)}</a></p>`,
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
	await sendMailjetMessage({
		toEmail: submission.email,
		toName: submission.name,
		subject: email.subject,
		textPart: email.textPart,
		htmlPart: email.htmlPart
	});
	return { ...submission, verifyUrl: verifyUrl.toString() };
}

/** Minimal HTML escaping for the recipient's name in the e-mail body. */
function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => {
		switch (ch) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}
