// Durable delivery intent lives on the verified submission, not in memory.
// One atomic claim covers verification clicks and cron retries. SMTP cannot
// promise exactly-once delivery after acceptance followed by a process crash;
// a stable Message-ID makes that narrow at-least-once retry identifiable.
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { db } from './db';
import { contactSubmissions } from './db/schema';
import { escapeHtml } from './emailText';
import { sendProtonMailEmail, type ProtonMailMessage } from './protonMail';

// Longer than the SMTP client's hard 10-second deadline. It is both a crash
// lease and a retry delay, so repeated clicks cannot hammer a failed provider.
const RETRY_DELAY_MS = 60_000;

export function buildContactNotification(input: {
	id: number;
	verificationToken: string;
	name: string;
	email: string;
	message: string | null;
}): ProtonMailMessage {
	const message = input.message ?? 'No message provided.';
	return {
		toEmail: 'contact@moderaty.com',
		replyTo: input.email,
		// Hash the random submission identity: integer IDs collide across dev,
		// production, and self-hosts. Never expose the verification token.
		messageId: `<moderaty-contact-${createHash('sha256').update(input.verificationToken).digest('hex')}@moderaty.com>`,
		subject: 'Verified contact request — Moderaty',
		textPart: [`Verified contact request #${input.id}`, '', `Name: ${input.name}`, `E-mail: ${input.email}`, '', 'Message:', message].join('\n'),
		htmlPart: [
			`<h1>Verified contact request #${input.id}</h1>`,
			`<p>Name: ${escapeHtml(input.name)}<br>E-mail: ${escapeHtml(input.email)}</p>`,
			`<p>Message:<br>${escapeHtml(message).replace(/\r\n?|\n/g, '<br>')}</p>`
		].join('')
	};
}

/** Claims one due verified row and acknowledges only the same claim. */
export async function deliverContactNotification(id: number, deadline?: number): Promise<'sent' | 'deferred'> {
	if (deadline !== undefined && Date.now() >= deadline) return 'deferred';
	const claim = randomBytes(16).toString('hex');
	const [submission] = await db.update(contactSubmissions)
		.set({ notificationClaim: claim, notificationDueAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString() })
		.where(and(
			eq(contactSubmissions.id, id),
			eq(contactSubmissions.status, 'verified'),
			isNull(contactSubmissions.notificationSentAt),
			lte(contactSubmissions.notificationDueAt, new Date().toISOString())
		))
		.returning();
	if (!submission) return 'deferred';
	const ownedClaim = and(eq(contactSubmissions.id, id), eq(contactSubmissions.notificationClaim, claim));
	try {
		await sendProtonMailEmail(buildContactNotification(submission), deadline);
		const acknowledged = await db.update(contactSubmissions)
			.set({ notificationSentAt: new Date().toISOString(), notificationDueAt: null, notificationClaim: null })
			.where(ownedClaim).returning({ id: contactSubmissions.id });
		if (acknowledged.length !== 1) throw new Error('contact notification delivery claim was lost');
		return 'sent';
	} catch {
		// Do not log message bodies, addresses, tokens, or provider errors.
		console.error('[contact] notification delivery failed; retry remains queued', { id });
		await db.update(contactSubmissions)
			.set({ notificationClaim: null, notificationDueAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString() })
			.where(ownedClaim);
		throw new Error('Contact notification delivery failed; retry queued.');
	}
}

/** Existing cron drives recovery, at most one request per invocation. */
export async function retryContactNotifications(deadline: number): Promise<{ sent: number; errors: number }> {
	if (Date.now() >= deadline) return { sent: 0, errors: 0 };
	const submission = await db.select({ id: contactSubmissions.id }).from(contactSubmissions)
		.where(and(
			eq(contactSubmissions.status, 'verified'),
			isNull(contactSubmissions.notificationSentAt),
			lte(contactSubmissions.notificationDueAt, new Date().toISOString())
		))
		.orderBy(asc(contactSubmissions.notificationDueAt), asc(contactSubmissions.id)).limit(1).get();
	if (!submission) return { sent: 0, errors: 0 };
	try {
		return { sent: await deliverContactNotification(submission.id, deadline) === 'sent' ? 1 : 0, errors: 0 };
	} catch {
		return { sent: 0, errors: 1 };
	}
}
