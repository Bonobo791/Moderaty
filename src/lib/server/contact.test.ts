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

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
	env: {
		APP_URL: 'https://moderaty.app',
		MJ_APIKEY_PUBLIC: 'api-key',
		MJ_APIKEY_PRIVATE: 'secret-key',
		MAILJET_FROM_EMAIL: 'no-reply@moderaty.app'
	} as Record<string, string | undefined>,
	sendMailjetMessage: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

vi.mock('./mailjet', () => ({
	sendMailjetMessage: mocks.sendMailjetMessage
}));

import { setupTestDb, testDb } from './testdb';
import { contactSubmissions } from './db/schema';
import {
	CONTACT_OPT_IN_TEXT,
	buildVerificationEmail,
	createOrReusePendingSubmission,
	parseContactForm,
	submitContactRequest,
	verifyContactToken
} from './contact';

setupTestDb(['contact_submissions']);

const SUBMIT = { name: 'Fan', email: 'Fan@Example.com', consentText: CONTACT_OPT_IN_TEXT, ip: '127.0.0.1', userAgent: 'test' };

async function rows() {
	return testDb().db.select().from(contactSubmissions);
}

beforeEach(() => {
	mocks.env.APP_URL = 'https://moderaty.app';
	mocks.sendMailjetMessage.mockReset();
	mocks.sendMailjetMessage.mockResolvedValue({ messageId: 1, messageUuid: 'uuid-1' });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('parseContactForm', () => {
	test('accepts name, e-mail, and the ticked opt-in box; normalizes case and whitespace', () => {
		const form = new FormData();
		form.set('name', '  Fan  ');
		form.set('email', '  Fan@Example.com ');
		form.set('opt_in', 'on');
		expect(parseContactForm(form)).toEqual({ ok: true, name: 'Fan', email: 'fan@example.com' });
	});

	test('rejects an unticked opt-in box even with valid name and e-mail', () => {
		const form = new FormData();
		form.set('name', 'Fan');
		form.set('email', 'fan@example.com');
		const result = parseContactForm(form);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/opt-in/);
	});

	test('rejects an empty name', () => {
		const form = new FormData();
		form.set('name', '   ');
		form.set('email', 'fan@example.com');
		form.set('opt_in', 'on');
		const result = parseContactForm(form);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/name/i);
	});

	test('rejects an over-long name', () => {
		const form = new FormData();
		form.set('name', 'x'.repeat(201));
		form.set('email', 'fan@example.com');
		form.set('opt_in', 'on');
		const result = parseContactForm(form);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/201|characters/);
	});

	test.each(['not-an-email', 'a@b', 'a b@example.com', '@example.com', 'a@'])(
		'rejects invalid e-mail %s',
		(email) => {
			const form = new FormData();
			form.set('name', 'Fan');
			form.set('email', email);
			form.set('opt_in', 'on');
			const result = parseContactForm(form);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatch(/e-mail/i);
		}
	);

	test('keeps submitted values on error so the form can re-render them', () => {
		const form = new FormData();
		form.set('name', 'Fan');
		form.set('email', 'bad-address');
		form.set('opt_in', 'on');
		const result = parseContactForm(form);
		expect(result).toEqual({ ok: false, error: expect.any(String), name: 'Fan', email: 'bad-address' });
	});
});

describe('createOrReusePendingSubmission', () => {
	test('the database enforces at most one pending row per e-mail (partial unique index)', async () => {
		const future = new Date(Date.now() + 86_400_000).toISOString();
		await testDb().db.insert(contactSubmissions).values({
			email: 'fan@example.com',
			name: 'A',
			status: 'pending',
			verificationToken: 'a'.repeat(64),
			expiresAt: future,
			consentText: 'x',
			ip: '1.1.1.1',
			userAgent: 'test'
		});
		// A second pending row for the same address must be rejected — without
		// the partial unique index this insert succeeds and the check-then-act
		// race yields two rows with two tokens (human review).
		await expect(
			testDb().db.insert(contactSubmissions).values({
				email: 'fan@example.com',
				name: 'B',
				status: 'pending',
				verificationToken: 'b'.repeat(64),
				expiresAt: future,
				consentText: 'x',
				ip: '2.2.2.2',
				userAgent: 'test'
			})
		).rejects.toThrow();
	});

	test('two concurrent submissions for the same address converge on one row and one token', async () => {
		const [first, second] = await Promise.all([
			createOrReusePendingSubmission(SUBMIT),
			createOrReusePendingSubmission(SUBMIT)
		]);
		const stored = await rows();
		expect(stored).toHaveLength(1);
		expect(first.id).toBe(second.id);
		expect(first.verificationToken).toBe(second.verificationToken);
		expect(first.reused || second.reused).toBe(true);
	});

	test('a verified submission frees the pending slot for a fresh one', async () => {
		const first = await createOrReusePendingSubmission(SUBMIT);
		await verifyContactToken(first.verificationToken);
		const second = await createOrReusePendingSubmission(SUBMIT);
		expect(second.reused).toBe(false);
		expect(second.verificationToken).not.toBe(first.verificationToken);
		const stored = await rows();
		expect(stored).toHaveLength(2);
		expect(stored.filter((r) => r.status === 'pending')).toHaveLength(1);
		expect(stored.filter((r) => r.status === 'verified')).toHaveLength(1);
	});

	test('inserts a pending row with a random token and 7-day expiry', async () => {
		const submission = await createOrReusePendingSubmission(SUBMIT);
		expect(submission.reused).toBe(false);
		expect(submission.verificationToken).toMatch(/^[0-9a-f]{64}$/);
		const stored = await rows();
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			email: 'fan@example.com',
			name: 'Fan',
			status: 'pending',
			consentText: CONTACT_OPT_IN_TEXT,
			ip: '127.0.0.1',
			userAgent: 'test'
		});
		const ttl = Date.parse(stored[0].expiresAt) - Date.now();
		expect(ttl).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
		expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
	});

	test('reuses the unexpired pending row for the same e-mail (same token) and refreshes it', async () => {
		const first = await createOrReusePendingSubmission(SUBMIT);
		const second = await createOrReusePendingSubmission({ ...SUBMIT, name: 'Fan Updated' });
		expect(second.reused).toBe(true);
		expect(second.verificationToken).toBe(first.verificationToken);
		expect(second.id).toBe(first.id);
		const stored = await rows();
		expect(stored).toHaveLength(1);
		expect(stored[0].name).toBe('Fan Updated');
	});

	test('reuses the pending row after expiry (slides the expiry) — one pending row per e-mail', async () => {
		// Partial-unique-index contract (human review): an expired pending row
		// still holds the slot; the resubmission refreshes it (the e-mail is
		// re-sent with the same link) instead of creating a second pending row.
		const first = await createOrReusePendingSubmission(SUBMIT);
		await testDb()
			.db.update(contactSubmissions)
			.set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
			.where(eq(contactSubmissions.id, first.id));
		const second = await createOrReusePendingSubmission(SUBMIT);
		expect(second.reused).toBe(true);
		expect(second.id).toBe(first.id);
		expect(second.verificationToken).toBe(first.verificationToken);
		const stored = await rows();
		expect(stored).toHaveLength(1);
		expect(new Date(stored[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
	});

	test('creates a NEW row after the previous one was verified', async () => {
		const first = await createOrReusePendingSubmission(SUBMIT);
		await testDb()
			.db.update(contactSubmissions)
			.set({ status: 'verified', verifiedAt: new Date().toISOString() })
			.where(eq(contactSubmissions.id, first.id));
		const second = await createOrReusePendingSubmission(SUBMIT);
		expect(second.reused).toBe(false);
		expect(await rows()).toHaveLength(2);
	});
});

describe('verifyContactToken', () => {
	async function seedPending(token: string, overrides: Partial<typeof SUBMIT> = {}) {
		// The fixture e-mail is deliberately mixed-case; the domain normalizes
		// it to lowercase, so queries must use the canonical form.
		await createOrReusePendingSubmission({ ...SUBMIT, ...overrides });
		await testDb().db.update(contactSubmissions).set({ verificationToken: token }).where(eq(contactSubmissions.email, 'fan@example.com'));
		return testDb().db.select().from(contactSubmissions).where(eq(contactSubmissions.verificationToken, token)).get();
	}

	test('marks a valid unexpired token verified and stamps verified_at', async () => {
		const row = await seedPending('tok-valid');
		const result = await verifyContactToken('tok-valid');
		expect(result).toEqual({ status: 'verified', email: 'fan@example.com' });
		const stored = await testDb().db.select().from(contactSubmissions).where(eq(contactSubmissions.id, row!.id)).get();
		expect(stored!.status).toBe('verified');
		expect(stored!.verifiedAt).toEqual(expect.any(String));
	});

	test('re-verifying an already verified token reports already_verified (idempotent)', async () => {
		await seedPending('tok-done');
		await verifyContactToken('tok-done');
		const result = await verifyContactToken('tok-done');
		expect(result).toEqual({ status: 'already_verified', email: 'fan@example.com' });
	});

	test('reports expired for an unverified token past its expiry', async () => {
		const row = await seedPending('tok-old');
		await testDb().db.update(contactSubmissions).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(contactSubmissions.id, row!.id));
		const result = await verifyContactToken('tok-old');
		expect(result).toEqual({ status: 'expired', email: 'fan@example.com' });
		// Expired verification must not flip the row.
		const stored = await testDb().db.select().from(contactSubmissions).where(eq(contactSubmissions.id, row!.id)).get();
		expect(stored!.status).toBe('pending');
	});

	test('reports invalid for an unknown token', async () => {
		expect(await verifyContactToken('nope')).toEqual({ status: 'invalid' });
	});
});

describe('submitContactRequest', () => {
	test('records the pending row FIRST, then sends the verification e-mail with the APP_URL link', async () => {
		const result = await submitContactRequest(SUBMIT);

		expect(mocks.sendMailjetMessage).toHaveBeenCalledTimes(1);
		const sent = mocks.sendMailjetMessage.mock.calls[0][0];
		expect(sent.toEmail).toBe('fan@example.com');
		expect(sent.toName).toBe('Fan');
		expect(sent.subject).toContain('Confirm');
		const expectedUrl = `https://moderaty.app/contact/verify?token=${result.verificationToken}`;
		expect(sent.textPart).toContain(expectedUrl);
		expect(sent.htmlPart).toContain(expectedUrl);
		expect(result.verifyUrl).toBe(expectedUrl);
		expect((await rows())[0].status).toBe('pending');
	});

	test('propagates a send failure loudly and leaves the pending row for retry', async () => {
		mocks.sendMailjetMessage.mockRejectedValue(new Error('verification e-mail could not be sent (HTTP 500)'));
		await expect(submitContactRequest(SUBMIT)).rejects.toThrow(/could not be sent/);
		const stored = await rows();
		expect(stored).toHaveLength(1);
		expect(stored[0].status).toBe('pending');
	});

	test('fails loudly when APP_URL is not configured, before touching the database', async () => {
		mocks.env.APP_URL = undefined;
		await expect(submitContactRequest(SUBMIT)).rejects.toThrow(/APP_URL is not configured/);
		expect(await rows()).toHaveLength(0);
		expect(mocks.sendMailjetMessage).not.toHaveBeenCalled();
	});
});

describe('buildVerificationEmail', () => {
	test('embeds the link in subject-agnostic text and HTML parts', () => {
		const email = buildVerificationEmail({ name: 'A & B', verifyUrl: 'https://moderaty.app/contact/verify?token=t' });
		expect(email.textPart).toContain('https://moderaty.app/contact/verify?token=t');
		expect(email.htmlPart).toContain('https://moderaty.app/contact/verify?token=t');
		// HTML-escaped name in the HTML part, raw name in the text part.
		expect(email.htmlPart).toContain('A &amp; B');
		expect(email.textPart).toContain('A & B');
	});
});
