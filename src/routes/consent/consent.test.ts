// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {
		APP_URL: 'http://localhost:5173',
		ENCRYPTION_KEY: 'test-encryption-key'
	} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { setupTestDb, testDb } from '$lib/server/testdb';
import { makeCookies } from '$lib/server/testcookies';
import { channels, consents, sessions, users } from '$lib/server/db/schema';
import {
	CONSENT_CHECKBOX_TEXT,
	LEGAL_VERSION,
	PENDING_CONSENT_COOKIE,
	parkPendingConsent,
	type PendingConsent
} from '$lib/server/legal';

import { actions, load } from './+page.server';

setupTestDb(['consents', 'sessions', 'users', 'channels']);

const here = dirname(fileURLToPath(import.meta.url));
const consentPage = readFileSync(join(here, '+page.svelte'), 'utf8');

function cookiesWithPending(payload: PendingConsent) {
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, payload);
	return cookies;
}

function consentRequest(fields: Record<string, string>) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return new Request('http://localhost/consent', {
		method: 'POST',
		body: form,
		headers: { 'user-agent': 'moderaty-test/1.0' }
	});
}

async function captureAction(cookies: ReturnType<typeof makeCookies>, fields: Record<string, string>) {
	try {
		// fail() returns an ActionFailure ({ status, data }); redirect/error throw.
		return (await actions.default({ cookies, request: consentRequest(fields), getClientAddress: () => '203.0.113.7' } as never)) as
			| { status: number }
			| undefined;
	} catch (e) {
		return e as { status: number; location?: string };
	}
}

const NEW_SUB: PendingConsent = { kind: 'new', sub: 'sub-1', email: 'one@example.com', displayName: 'One' };

test('page states: consent sentence matches the logged text, docs are linked, errors are announced', () => {
	// The visible sentence must stay in sync with CONSENT_CHECKBOX_TEXT — that
	// constant is what the consent log stores as "the exact text shown".
	expect(consentPage).toContain('I am at least 18 years old and agree to the');
	expect(consentPage).toContain('href="/terms"');
	expect(consentPage).toContain('href="/privacy"');
	expect(consentPage).toContain('href="/dpa"');
	expect(consentPage).toMatch(/class="error-box"[^>]*role="alert"/);
	// The consent checkbox renders unticked by default (no checked attribute).
	expect(consentPage).not.toMatch(/name="consent"[^>]*checked/);
});

test('load without a pending cookie redirects to /login', () => {
	try {
		load({ cookies: makeCookies() } as never);
		expect.unreachable('load should redirect');
	} catch (e) {
		expect(e).toMatchObject({ status: 302, location: '/login' });
	}
});

test('load with a tampered pending cookie redirects to /login', () => {
	const cookies = makeCookies();
	cookies.set(PENDING_CONSENT_COOKIE, 'forged-ciphertext', { path: '/' });
	try {
		load({ cookies } as never);
		expect.unreachable('load should redirect');
	} catch (e) {
		expect(e).toMatchObject({ status: 302, location: '/login' });
	}
});

test('action without a pending cookie fails with 400 and writes nothing', async () => {
	const res = await captureAction(makeCookies(), { consent: 'on' });
	expect(res).toMatchObject({ status: 400 });
	expect(await testDb().db.select().from(users).all()).toHaveLength(0);
	expect(await testDb().db.select().from(consents).all()).toHaveLength(0);
});

test('action without the required checkbox fails with 400 and writes nothing', async () => {
	const res = await captureAction(cookiesWithPending(NEW_SUB), {});
	expect(res).toMatchObject({ status: 400 });
	expect(await testDb().db.select().from(users).all()).toHaveLength(0);
	expect(await testDb().db.select().from(consents).all()).toHaveLength(0);
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(0);
});

test('a new user is created only at acceptance, with a full evidentiary consent record', async () => {
	const cookies = cookiesWithPending(NEW_SUB);

	const thrown = await captureAction(cookies, { consent: 'on' });

	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	const created = await testDb().db.select().from(users).all();
	expect(created).toHaveLength(1);
	expect(created[0]).toMatchObject({ googleSub: 'sub-1', email: 'one@example.com', displayName: 'One', plan: 'free' });

	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		userId: created[0].id,
		docVersion: LEGAL_VERSION,
		checkboxText: CONSENT_CHECKBOX_TEXT,
		ip: '203.0.113.7',
		userAgent: 'moderaty-test/1.0',
		marketingOptIn: 0
	});

	const createdSessions = await testDb().db.select().from(sessions).all();
	expect(createdSessions).toHaveLength(1);
	expect(createdSessions[0].userId).toBe(created[0].id);
	expect(cookies.setCalls.find((c) => c.name === 'moderaty_session')).toBeTruthy();
	// The pending cookie is consumed — acceptance cannot be replayed.
	expect(cookies.get(PENDING_CONSENT_COOKIE)).toBeUndefined();
});

test('the marketing opt-in is recorded separately and only when ticked', async () => {
	await captureAction(cookiesWithPending(NEW_SUB), { consent: 'on', marketing: 'on' });

	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toHaveLength(1);
	expect(rows[0].marketingOptIn).toBe(1);
});

test('only the first-ever user claims orphaned channels', async () => {
	await testDb().db.insert(channels).values({ id: 'UC1', title: 'Old', refreshTokenEnc: 'enc', active: 1, createdAt: '2026-01-01T00:00:00.000Z' });
	await captureAction(cookiesWithPending(NEW_SUB), { consent: 'on' });
	expect((await testDb().db.select().from(channels).all())[0].userId).toBe(
		(await testDb().db.select().from(users).all())[0].id
	);

	// A second, distinct signup while another orphan exists must NOT claim it:
	// the claim is one-time initialization, not a per-signup action.
	await testDb().db.insert(channels).values({ id: 'UC2', title: 'Late', refreshTokenEnc: 'enc', active: 1, createdAt: '2026-01-01T00:00:00.000Z' });
	await captureAction(cookiesWithPending({ kind: 'new', sub: 'sub-2', email: 'two@example.com', displayName: 'Two' }), { consent: 'on' });

	expect((await testDb().db.select().from(channels).all()).find((c) => c.id === 'UC2')!.userId).toBeNull();
});

test('an existing user re-accepting adds a consent row without duplicating the account', async () => {
	await testDb().db.insert(users).values({ id: 'user-1', googleSub: 'sub-1', email: 'one@example.com', displayName: 'One' });
	const cookies = cookiesWithPending({ kind: 'existing', userId: 'user-1' });

	const thrown = await captureAction(cookies, { consent: 'on' });

	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	expect(await testDb().db.select().from(users).all()).toHaveLength(1);
	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ userId: 'user-1', docVersion: LEGAL_VERSION });
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(1);
});

test('an existing-user pending payload naming an unknown account fails with 400', async () => {
	const res = await captureAction(cookiesWithPending({ kind: 'existing', userId: 'ghost' }), { consent: 'on' });
	expect(res).toMatchObject({ status: 400 });
	expect(await testDb().db.select().from(consents).all()).toHaveLength(0);
});
