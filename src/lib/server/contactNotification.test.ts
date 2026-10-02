import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./protonMail', async (importOriginal) => ({
	...(await importOriginal<typeof import('./protonMail')>()),
	sendProtonMailEmail: mocks.send
}));

import { setupTestDb, testDb } from './testdb';
import { contactSubmissions } from './db/schema';
import { DeadlineExceededError } from './http';
import { ProtonMailConfigurationError } from './protonMail';
import { CONTACT_OPT_IN_TEXT, createOrReusePendingSubmission, verifyContactToken } from './contact';
import { buildContactNotification, deliverContactNotification, retryContactNotifications } from './contactNotification';

setupTestDb(['contact_submissions']);
const INPUT = { verificationToken: 'a'.repeat(64), name: '<Fan & friends>', email: 'fan@example.com', message: 'First line\n<script>bad()</script> & text', consentText: CONTACT_OPT_IN_TEXT, ip: '127.0.0.1', userAgent: 'test' };
beforeEach(() => {
	mocks.send.mockReset();
	mocks.send.mockResolvedValue({ messageId: '<accepted@example.com>' });
});
afterEach(() => vi.restoreAllMocks());
const row = (id: number) => testDb().db.select().from(contactSubmissions).where(eq(contactSubmissions.id, id)).get();
async function due(id: number) {
	await testDb().db.update(contactSubmissions).set({ notificationDueAt: new Date(Date.now() - 1).toISOString() }).where(eq(contactSubmissions.id, id));
}

describe('verified contact notifications', () => {
	test('builds safe text and escaped multiline HTML with a fixed recipient and reply address', () => {
		const mail = buildContactNotification({ ...INPUT, id: 42 });
		expect(mail).toMatchObject({ toEmail: 'contact@moderaty.com', replyTo: 'fan@example.com', messageId: expect.stringMatching(/^<moderaty-contact-[a-f0-9]{64}@moderaty\.com>$/), subject: 'Verified contact request — Moderaty' });
		expect(mail.textPart).toContain(INPUT.message);
		expect(mail.htmlPart).toContain('&lt;Fan &amp; friends&gt;');
		expect(mail.htmlPart).toContain('First line<br>&lt;script&gt;bad()&lt;/script&gt; &amp; text');
		expect(mail.htmlPart).not.toContain('<script>');
		expect(mail.textPart).not.toContain(INPUT.ip);
	});
	test('renders the no-message case explicitly', () => {
		const mail = buildContactNotification({ ...INPUT, id: 1, message: null });
		expect(mail.textPart).toContain('No message provided.');
		expect(mail.htmlPart).toContain('No message provided.');
	});
	test('queues durably before SMTP and sends only once after verification', async () => {
		const submission = await createOrReusePendingSubmission(INPUT);
		expect(mocks.send).not.toHaveBeenCalled();
		mocks.send.mockImplementationOnce(async () => {
			expect(await row(submission.id)).toMatchObject({ status: 'verified', message: INPUT.message, notificationDueAt: expect.any(String), notificationClaim: expect.any(String), notificationSentAt: null });
			return { messageId: '<accepted@example.com>' };
		});
		expect(await verifyContactToken(submission.verificationToken)).toMatchObject({ status: 'verified' });
		const stored = await row(submission.id);
		expect(stored).toMatchObject({ notificationSentAt: expect.any(String), notificationDueAt: null, notificationClaim: null });
		await verifyContactToken(submission.verificationToken);
		await retryContactNotifications(Date.now() + 1000);
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});
	test('concurrent verification and cron attempts have one active sender', async () => {
		const submission = await createOrReusePendingSubmission(INPUT);
		let release!: () => void;
		let started!: () => void;
		const sending = new Promise<void>((resolve) => { started = resolve; });
		mocks.send.mockImplementationOnce(async () => {
			started();
			await new Promise<void>((resolve) => { release = resolve; });
			return { messageId: '<accepted@example.com>' };
		});
		const first = verifyContactToken(submission.verificationToken);
		await sending;
		expect(await verifyContactToken(submission.verificationToken)).toMatchObject({ status: 'delivery_pending' });
		expect(await retryContactNotifications(Date.now() + 1000)).toEqual({ sent: 0, errors: 0 });
		expect(mocks.send).toHaveBeenCalledTimes(1);
		release();
		await first;
		expect(await verifyContactToken(submission.verificationToken)).toMatchObject({ status: 'already_verified' });
	});
	test('SMTP failure leaves a verified retryable request and cron recovers without another click', async () => {
		const submission = await createOrReusePendingSubmission(INPUT);
		mocks.send.mockRejectedValueOnce(new Error('SMTP unavailable'));
		expect(await verifyContactToken(submission.verificationToken)).toMatchObject({ status: 'delivery_pending' });
		expect(await row(submission.id)).toMatchObject({ status: 'verified', notificationDueAt: expect.any(String), notificationSentAt: null, notificationClaim: null });
		await due(submission.id);
		const deadline = Date.now() + 1000;
		expect(await retryContactNotifications(deadline)).toEqual({ sent: 1, errors: 0 });
		expect(mocks.send.mock.calls[1][1]).toBe(deadline);
		expect(mocks.send.mock.calls[1][0].messageId).toBe(mocks.send.mock.calls[0][0].messageId);
		expect((await row(submission.id))?.notificationSentAt).toEqual(expect.any(String));
	});
	test('reopening a due failed request recovers it and reports already verified', async () => {
		const submission = await createOrReusePendingSubmission(INPUT);
		mocks.send.mockRejectedValueOnce(new Error('SMTP unavailable'));
		await verifyContactToken(submission.verificationToken);
		await due(submission.id);
		expect(await verifyContactToken(submission.verificationToken)).toMatchObject({ status: 'already_verified' });
		expect(mocks.send).toHaveBeenCalledTimes(2);
	});
	test('never queues invalid, expired, or historical verified submissions', async () => {
		const submission = await createOrReusePendingSubmission(INPUT);
		await testDb().db.update(contactSubmissions).set({ expiresAt: new Date(0).toISOString() }).where(eq(contactSubmissions.id, submission.id));
		expect(await verifyContactToken(submission.verificationToken)).toMatchObject({ status: 'expired' });
		expect(await verifyContactToken('unknown')).toMatchObject({ status: 'invalid' });
		await testDb().db.update(contactSubmissions).set({ status: 'verified' }).where(eq(contactSubmissions.id, submission.id));
		expect(await verifyContactToken(submission.verificationToken)).toMatchObject({ status: 'already_verified' });
		await retryContactNotifications(Date.now() + 1000);
		expect(mocks.send).not.toHaveBeenCalled();
	});
	test('expired delivery claims recover, while fresh claims and spent budgets defer', async () => {
		const submission = await createOrReusePendingSubmission(INPUT);
		await testDb().db.update(contactSubmissions).set({ status: 'verified', notificationClaim: 'crashed-worker', notificationDueAt: new Date(Date.now() + 60_000).toISOString() }).where(eq(contactSubmissions.id, submission.id));
		expect(await deliverContactNotification(submission.id)).toBe('deferred');
		await due(submission.id);
		expect(await retryContactNotifications(Date.now() - 1)).toEqual({ sent: 0, errors: 0 });
		expect(mocks.send).not.toHaveBeenCalled();
		expect(await retryContactNotifications(Date.now() + 1000)).toEqual({ sent: 1, errors: 0 });
	});
	test('cron retries one oldest due request and surfaces failure counts without dropping either request', async () => {
		for (const email of ['first@example.com', 'second@example.com']) {
			const submission = await createOrReusePendingSubmission({ ...INPUT, email });
			await testDb().db.update(contactSubmissions).set({ status: 'verified', notificationDueAt: new Date(0).toISOString() }).where(eq(contactSubmissions.id, submission.id));
		}
		mocks.send.mockRejectedValueOnce(new Error('SMTP unavailable'));
		expect(await retryContactNotifications(Date.now() + 1000)).toEqual({ sent: 0, errors: 1 });
		expect(mocks.send).toHaveBeenCalledTimes(1);
		expect(mocks.send.mock.calls[0][0].replyTo).toBe('first@example.com');
		expect(await retryContactNotifications(Date.now() + 1000)).toEqual({ sent: 1, errors: 0 });
		expect(mocks.send.mock.calls[1][0].replyTo).toBe('second@example.com');
	});
	test('uses the refreshed message at verification time', async () => {
		const submission = await createOrReusePendingSubmission(INPUT);
		await createOrReusePendingSubmission({ ...INPUT, message: 'Newest\nrequest' });
		await verifyContactToken(submission.verificationToken);
		expect(mocks.send.mock.calls[0][0].textPart).toContain('Newest\nrequest');
		expect(mocks.send.mock.calls[0][0].textPart).not.toContain(INPUT.message);
	});
});


test('stable notification IDs distinguish independent databases with the same row ID', () => {
	const first = { ...INPUT, id: 1, verificationToken: 'a'.repeat(64) };
	const second = { ...INPUT, id: 1, verificationToken: 'b'.repeat(64) };
	expect(buildContactNotification(first).messageId).toBe(buildContactNotification(first).messageId);
	expect(buildContactNotification(first).messageId).not.toBe(buildContactNotification(second).messageId);
	expect(buildContactNotification(first).messageId).not.toContain(first.verificationToken);
});

test('escapes the entire notification body even if a malformed request ID crosses the runtime boundary', () => {
	const id = '<img src=x onerror=alert(1)>' as unknown as number;
	const mail = buildContactNotification({ ...INPUT, id });
	expect(mail.htmlPart).not.toContain('<img');
	expect(mail.htmlPart).toContain('&lt;img src=x onerror=alert(1)&gt;');
	expect(mail.textPart).toContain('<img src=x onerror=alert(1)>');
});


test('shared-deadline exhaustion defers delivery without an SMTP error or lost retry', async () => {
	const submission = await createOrReusePendingSubmission(INPUT);
	await testDb().db.update(contactSubmissions).set({ status: 'verified', notificationDueAt: new Date(0).toISOString() }).where(eq(contactSubmissions.id, submission.id));
	mocks.send.mockRejectedValueOnce(new DeadlineExceededError());
	const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
	expect(await retryContactNotifications(Date.now() + 1000)).toEqual({ sent: 0, errors: 0 });
	expect(await row(submission.id)).toMatchObject({ notificationClaim: null, notificationDueAt: expect.any(String), notificationSentAt: null });
	expect(errors).not.toHaveBeenCalled();
});

test('preserves safe SMTP configuration diagnostics without exposing arbitrary provider errors', async () => {
	const submission = await createOrReusePendingSubmission(INPUT);
	const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
	mocks.send.mockRejectedValueOnce(new ProtonMailConfigurationError('PROTON_SMTP_TOKEN is not configured'));
	await verifyContactToken(submission.verificationToken);
	expect(JSON.stringify(errors.mock.calls)).toContain('PROTON_SMTP_TOKEN is not configured');
	await due(submission.id);
	mocks.send.mockRejectedValueOnce(new Error('raw provider secret and message content'));
	await verifyContactToken(submission.verificationToken);
	expect(JSON.stringify(errors.mock.calls)).not.toContain('raw provider secret');
});
