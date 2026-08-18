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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {
		APP_URL: 'http://localhost:5173',
		MJ_APIKEY_PUBLIC: 'api-key',
		MJ_APIKEY_PRIVATE: 'secret-key',
		MAILJET_FROM_EMAIL: 'no-reply@moderaty.app'
	} as Record<string, string | undefined>,
	sendMailjetMessage: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/mailjet', () => ({ sendMailjetMessage: mocks.sendMailjetMessage }));

import { setupTestDb, testDb } from '$lib/server/testdb';
import { contactSubmissions } from '$lib/server/db/schema';
import { CONTACT_OPT_IN_TEXT } from '$lib/server/contact';

import { actions, load } from './+page.server';

setupTestDb(['contact_submissions']);

const here = dirname(fileURLToPath(import.meta.url));
const contactPage = readFileSync(join(here, '+page.svelte'), 'utf8');

function contactRequest(fields: Record<string, string>) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return new Request('http://localhost/contact', {
		method: 'POST',
		body: form,
		headers: { 'user-agent': 'moderaty-test/1.0' }
	});
}

/** Calls the default action; fail() resolves to ActionFailure, redirect throws. */
async function captureAction(fields: Record<string, string>) {
	try {
		return await actions.default({
			request: contactRequest(fields),
			getClientAddress: () => '203.0.113.7'
		} as never);
	} catch (e) {
		return e as { status: number; location?: string };
	}
}

const VALID = { name: 'Fan', email: 'fan@example.com', opt_in: 'on' };

async function pendingRows() {
	return testDb().db.select().from(contactSubmissions);
}

beforeEach(() => {
	mocks.env.APP_URL = 'http://localhost:5173';
	mocks.sendMailjetMessage.mockReset();
	mocks.sendMailjetMessage.mockResolvedValue({ messageId: 1, messageUuid: 'uuid-1' });
});

describe('contact page source', () => {
	test('renders the name and e-mail fields, the opt-in box, and a submit button', () => {
		expect(contactPage).toContain('name="name"');
		expect(contactPage).toContain('name="email"');
		expect(contactPage).toContain('type="email"');
		expect(contactPage).toContain('name="opt_in"');
		expect(contactPage).toContain('type="checkbox"');
		expect(contactPage).toContain('type="submit"');
	});

	test('labels every field (I13) and renders the exact opt-in sentence from data', () => {
		expect(contactPage).toContain('<label class="field" for="contact-name">Name</label>');
		expect(contactPage).toContain('<label class="field" for="contact-email">E-mail</label>');
		expect(contactPage).toContain('<label class="check" for="contact-opt-in">');
		// The sentence is rendered from data.optInText (the exact logged text) —
		// never hard-coded in the page markup.
		expect(contactPage).toContain('{data.optInText}');
	});

	test('has an error box and a success state', () => {
		expect(contactPage).toContain('class="error-box"');
		expect(contactPage).toContain('data.sent');
		expect(contactPage).toContain('Check your inbox');
	});
});

describe('contact load', () => {
	test('passes the opt-in sentence and sent=false by default', async () => {
		const data = (await load({ url: new URL('http://localhost/contact') } as never)) as {
			optInText: string;
			sent: boolean;
		};
		expect(data).toEqual({ optInText: CONTACT_OPT_IN_TEXT, sent: false });
	});

	test('exposes sent=true after the ?sent=1 redirect', async () => {
		const data = (await load({ url: new URL('http://localhost/contact?sent=1') } as never)) as {
			optInText: string;
			sent: boolean;
		};
		expect(data.sent).toBe(true);
	});
});

describe('contact action', () => {
	test('records the pending row with consent evidence, sends the verification e-mail, and redirects to ?sent=1', async () => {
		const outcome = await captureAction(VALID);
		expect(outcome).toMatchObject({ status: 303, location: '/contact?sent=1' });

		const rows = await pendingRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			email: 'fan@example.com',
			name: 'Fan',
			status: 'pending',
			consentText: CONTACT_OPT_IN_TEXT,
			ip: '203.0.113.7',
			userAgent: 'moderaty-test/1.0'
		});

		expect(mocks.sendMailjetMessage).toHaveBeenCalledTimes(1);
		const sent = mocks.sendMailjetMessage.mock.calls[0][0];
		expect(sent.toEmail).toBe('fan@example.com');
		expect(sent.textPart).toContain(`http://localhost:5173/contact/verify?token=${rows[0].verificationToken}`);
	});

	test('rejects a submission without the opt-in box (400) and writes nothing', async () => {
		const outcome = await captureAction({ name: 'Fan', email: 'fan@example.com' });
		expect(outcome).toMatchObject({ status: 400 });
		expect(await pendingRows()).toHaveLength(0);
		expect(mocks.sendMailjetMessage).not.toHaveBeenCalled();
	});

	test('rejects an invalid e-mail (400) and writes nothing', async () => {
		const outcome = await captureAction({ name: 'Fan', email: 'not-an-email', opt_in: 'on' });
		expect(outcome).toMatchObject({ status: 400 });
		expect(await pendingRows()).toHaveLength(0);
		expect(mocks.sendMailjetMessage).not.toHaveBeenCalled();
	});

	test('fails loudly (500) with a generic message when the send fails, keeping the pending row for retry', async () => {
		mocks.sendMailjetMessage.mockRejectedValue(new Error('verification e-mail could not be sent (HTTP 500)'));
		const outcome = await captureAction(VALID);
		expect(outcome).toMatchObject({ status: 500 });
		const data = outcome as { data?: { error?: string } };
		expect(data.data?.error).toContain('could not send the verification e-mail');
		expect(data.data?.error).not.toContain('HTTP 500');

		const rows = await pendingRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('pending');
	});

	test('resubmission with the same e-mail reuses the pending row and re-sends the same token', async () => {
		await captureAction(VALID);
		const firstRows = await pendingRows();
		const outcome = await captureAction({ ...VALID, name: 'Fan Two' });
		expect(outcome).toMatchObject({ status: 303 });

		const rows = await pendingRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(firstRows[0].id);
		expect(rows[0].verificationToken).toBe(firstRows[0].verificationToken);
		expect(rows[0].name).toBe('Fan Two');
		expect(mocks.sendMailjetMessage).toHaveBeenCalledTimes(2);
	});
});
