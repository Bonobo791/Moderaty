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

vi.mock('$lib/server/session', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/session')>();
	return { ...actual, createSession: vi.fn(actual.createSession) };
});

import { segmentConsentText } from '$lib/consentText';
import { TEST_OWNER, seedConsent, setupTestDb, testDb } from '$lib/server/testdb';
import { makeCookies } from '$lib/server/testcookies';
import { channels, consents, memberships, organizations, sessions, users } from '$lib/server/db/schema';
import {
	CONSENT_CHECKBOX_TEXT,
	LEGAL_VERSION,
	PENDING_CONSENT_COOKIE,
	REFUND_NOTICE_TEXT,
	parkPendingConsent,
	type PendingConsent
} from '$lib/server/legal';
import { createSession, getSessionUser } from '$lib/server/session';

import { actions, load } from './+page.server';

setupTestDb(['consents', 'sessions', 'users', 'channels', 'organizations', 'memberships']);

const here = dirname(fileURLToPath(import.meta.url));
const consentPage = readFileSync(join(here, '+page.svelte'), 'utf8');

function cookiesWithPending(payload: PendingConsent, state = 'state-1') {
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, state, payload);
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

async function captureAction(
	cookies: ReturnType<typeof makeCookies>,
	fields: Record<string, string>,
	state = 'state-1'
) {
	try {
		// fail() returns an ActionFailure ({ status, data }); redirect/error throw.
		return (await actions.default({
			cookies,
			request: consentRequest(fields),
			url: new URL(`http://localhost/consent?state=${state}`),
			getClientAddress: () => '203.0.113.7'
		} as never)) as
			| { status: number }
			| undefined;
	} catch (e) {
		return e as { status: number; location?: string };
	}
}

const NEW_SUB: PendingConsent = { kind: 'new', sub: 'sub-1', email: 'one@example.com', displayName: 'One' };

async function expectLoadRedirectsToLogin(cookies: ReturnType<typeof makeCookies>, url: string) {
	try {
		await load({ cookies, url: new URL(url) } as never);
		expect.unreachable('load should redirect');
	} catch (e) {
		expect(e).toMatchObject({ status: 302, location: '/login' });
	}
}

async function expectNothingWritten() {
	expect(await testDb().db.select().from(users).all()).toHaveLength(0);
	expect(await testDb().db.select().from(consents).all()).toHaveLength(0);
	expect(await testDb().db.select().from(organizations).all()).toHaveLength(0);
	expect(await testDb().db.select().from(memberships).all()).toHaveLength(0);
}

test('page states: the rendered sentence equals the logged text exactly, docs are linked, errors are announced', () => {
	// The visible sentence is derived from CONSENT_CHECKBOX_TEXT — the same
	// constant the consent log stores as "the exact text shown". Reassemble
	// the rendered segments (markup removed) and compare byte-for-byte.
	const segments = segmentConsentText(CONSENT_CHECKBOX_TEXT);
	expect(segments.map((s) => s.text).join('')).toBe(CONSENT_CHECKBOX_TEXT);
	expect(segments.filter((s) => s.href)).toEqual([
		{ text: 'Terms of Service', href: '/terms' },
		{ text: 'Privacy Policy', href: '/privacy' },
		{ text: 'Data Processing Agreement', href: '/dpa' }
	]);
	expect(consentPage).toContain('segmentConsentText');
	expect(consentPage).toMatch(/class="error-box"[^>]*role="alert"/);
	// The consent checkbox renders unticked by default (no checked attribute).
	expect(consentPage).not.toMatch(/name="consent"[^>]*checked/);
});

test('load hands the page the exact consent sentence the log will store', async () => {
	const data = (await load({
		cookies: cookiesWithPending(NEW_SUB),
		url: new URL('http://localhost/consent?state=state-1')
	} as never)) as Record<string, unknown>;
	expect(data).toMatchObject({ consentText: CONSENT_CHECKBOX_TEXT, kind: 'new', displayName: 'One' });
});

test('load also hands the page the refund notice, outside the evidentiary checkbox text', async () => {
	// The refund notice is consumer-rights copy (Terms §7, CDC Art. 49), not
	// part of the logged consent sentence: CONSENT_CHECKBOX_TEXT must stay
	// byte-identical so existing consent rows keep matching what was shown.
	expect(CONSENT_CHECKBOX_TEXT).toBe(
		'I am at least 18 years old and agree to the Terms of Service, Privacy Policy, and Data Processing Agreement'
	);
	expect(REFUND_NOTICE_TEXT).toContain('CDC Art. 49');
	expect(REFUND_NOTICE_TEXT).not.toContain(CONSENT_CHECKBOX_TEXT);
	const data = (await load({
		cookies: cookiesWithPending(NEW_SUB),
		url: new URL('http://localhost/consent?state=state-1')
	} as never)) as Record<string, unknown>;
	expect(data).toMatchObject({ refundText: REFUND_NOTICE_TEXT });
});

test('load without a pending cookie redirects to /login', async () => {
	await expectLoadRedirectsToLogin(makeCookies(), 'http://localhost/consent?state=state-1');
});

test('load without a state param redirects to /login', async () => {
	await expectLoadRedirectsToLogin(cookiesWithPending(NEW_SUB), 'http://localhost/consent');
});

test('load with a tampered pending cookie redirects to /login', async () => {
	const cookies = makeCookies();
	cookies.set(PENDING_CONSENT_COOKIE, 'forged-ciphertext', { path: '/' });
	await expectLoadRedirectsToLogin(cookies, 'http://localhost/consent?state=state-1');
});

test('action without a pending cookie fails with 400 and writes nothing', async () => {
	const res = await captureAction(makeCookies(), { consent: 'on' });
	expect(res).toMatchObject({ status: 400 });
	await expectNothingWritten();
});

test('action without the required checkbox fails with 400 and writes nothing', async () => {
	const res = await captureAction(cookiesWithPending(NEW_SUB), {});
	expect(res).toMatchObject({ status: 400 });
	await expectNothingWritten();
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
		email: 'one@example.com',
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

test('a new signup gets a personal org with owner membership, and its session resolves to that org', async () => {
	// getSessionUser fails loudly when a user has zero memberships — without a
	// personal org created in the signup transaction, every new account would
	// 500 on its very first authenticated request.
	const thrown = await captureAction(cookiesWithPending(NEW_SUB), { consent: 'on' });
	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });

	const user = (await testDb().db.select().from(users).all())[0];
	const orgs = await testDb().db.select().from(organizations).all();
	expect(orgs).toHaveLength(1);
	expect(orgs[0]).toMatchObject({ name: 'One', personalFor: user.id, plan: 'free' });
	const rows = await testDb().db.select().from(memberships).all();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ userId: user.id, orgId: orgs[0].id, role: 'owner' });

	// The session the signup just issued must resolve into that org on the
	// very next request.
	const session = (await testDb().db.select().from(sessions).all())[0];
	expect(session.activeOrgId).toBe(orgs[0].id);
	const resolved = await getSessionUser(session.id);
	expect(resolved?.user).toMatchObject({
		id: user.id,
		orgId: orgs[0].id,
		orgName: 'One',
		orgRole: 'owner',
		plan: 'free'
	});
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
	const firstUser = (await testDb().db.select().from(users).all())[0];
	const claimed = (await testDb().db.select().from(channels).all())[0];
	expect(claimed.userId).toBe(firstUser.id);
	// The claim also tenants the channel into the first user's personal org —
	// an untenanted orphan would 404 for everyone under ownedChannel.
	const personalOrg = (await testDb().db.select().from(organizations).all()).find((o) => o.personalFor === firstUser.id);
	expect(personalOrg).toBeDefined();
	expect(claimed.orgId).toBe(personalOrg?.id);
	// And the first user is the org's owner, so the claim is actionable.
	expect(await testDb().db.select().from(memberships).all()).toContainEqual(
		expect.objectContaining({ userId: firstUser.id, orgId: personalOrg?.id, role: 'owner' })
	);

	// A second, distinct signup while another orphan exists must NOT claim it:
	// the claim is one-time initialization, not a per-signup action. Assert the
	// signup actually succeeded — a failed signup would leave UC2 unclaimed and
	// pass this test for the wrong reason.
	await testDb().db.insert(channels).values({ id: 'UC2', title: 'Late', refreshTokenEnc: 'enc', active: 1, createdAt: '2026-01-01T00:00:00.000Z' });
	const second = await captureAction(cookiesWithPending({ kind: 'new', sub: 'sub-2', email: 'two@example.com', displayName: 'Two' }), { consent: 'on' });
	expect(second).toMatchObject({ status: 302, location: '/dashboard' });
	expect((await testDb().db.select().from(users).all()).map((u) => u.googleSub)).toContain('sub-2');

	const unclaimed = (await testDb().db.select().from(channels).all()).find((c) => c.id === 'UC2')!;
	expect(unclaimed.userId).toBeNull();
	expect(unclaimed.orgId).toBeNull();
});

/** Seeds existing sub-1 and completes its re-consent. */
async function seedExistingAndConsent() {
	await testDb()
		.db.insert(users)
		.values({ id: 'user-1', googleSub: 'sub-1', email: 'one@example.com', displayName: 'One' });
	const thrown = await captureAction(cookiesWithPending({ kind: 'existing', userId: 'user-1' }), { consent: 'on' });
	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
}

/** End state of one completed consent: one user, one consent row, one session. */
async function expectOneConsentedAccount() {
	expect(await testDb().db.select().from(users).all()).toHaveLength(1);
	expect(await testDb().db.select().from(consents).all()).toHaveLength(1);
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(1);
}

test('an existing user re-accepting adds a consent row without duplicating the account', async () => {
	await seedExistingAndConsent();

	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toHaveLength(1);
	// The e-mail is recorded from the users row — statutory-retention evidence
	// (Art. 16, III), since account deletion wipes users.email entirely.
	expect(rows[0]).toMatchObject({ userId: 'user-1', email: 'one@example.com', docVersion: LEGAL_VERSION });
	await expectOneConsentedAccount();
});

test('an existing-user pending payload naming an unknown account fails with 400', async () => {
	const res = await captureAction(cookiesWithPending({ kind: 'existing', userId: 'ghost' }), { consent: 'on' });
	expect(res).toMatchObject({ status: 400 });
	expect(await testDb().db.select().from(consents).all()).toHaveLength(0);
});

test('a pending identity parked under a different state is invisible to this flow', async () => {
	const res = await captureAction(cookiesWithPending(NEW_SUB, 'state-a'), { consent: 'on' }, 'state-b');
	expect(res).toMatchObject({ status: 400 });
	await expectNothingWritten();
});

test('a session-creation failure rolls back the account and consent, leaving the flow retryable', async () => {
	vi.mocked(createSession).mockRejectedValueOnce(new Error('sessions table unavailable'));
	const cookies = cookiesWithPending(NEW_SUB);

	const failed = await captureAction(cookies, { consent: 'on' });
	expect(failed).toBeInstanceOf(Error);
	// Nothing committed: the user, consent, and session writes are one unit.
	await expectNothingWritten();
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(0);

	// The pending cookie was never consumed, so the same submission retries clean.
	const retried = await captureAction(cookies, { consent: 'on' });
	expect(retried).toMatchObject({ status: 302, location: '/dashboard' });
	await expectOneConsentedAccount();
});

test('concurrent flows are isolated by state — each tab consents its own identity', async () => {
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, 'state-a', NEW_SUB);
	parkPendingConsent(cookies as never, 'state-b', { kind: 'new', sub: 'sub-2', email: 'two@example.com', displayName: 'Two' });

	// Tab B submits first: only sub-2's account is created.
	const first = await captureAction(cookies, { consent: 'on' }, 'state-b');
	expect(first).toMatchObject({ status: 302, location: '/dashboard' });
	const afterFirst = await testDb().db.select().from(users).all();
	expect(afterFirst).toHaveLength(1);
	expect(afterFirst[0].googleSub).toBe('sub-2');

	// Tab A's parked identity survived the overwrite attempt and still
	// consents its own intended account.
	const second = await captureAction(cookies, { consent: 'on' }, 'state-a');
	expect(second).toMatchObject({ status: 302, location: '/dashboard' });
	const all = await testDb().db.select().from(users).all();
	expect(all.map((u) => u.googleSub).sort()).toEqual(['sub-1', 'sub-2']);
	// Both entries consumed — the cookie itself is gone.
	expect(cookies.get(PENDING_CONSENT_COOKIE)).toBeUndefined();
});

// --- Signed-in re-consent: legal docs updated while a session was still ---
// --- sliding, so the (app) layout gate sent the user here without a      ---
// --- parked cookie.                                                      ---

/** Seeds user-1 to match TEST_OWNER. */
async function seedOwner() {
	await testDb()
		.db.insert(users)
		.values({ id: TEST_OWNER.id, googleSub: 'sub-1', email: TEST_OWNER.email, displayName: TEST_OWNER.displayName });
}

function consentLoadWithSession(cookies: ReturnType<typeof makeCookies>, url: string) {
	return load({
		cookies,
		url: new URL(url),
		locals: { user: TEST_OWNER }
	} as never) as Promise<Record<string, unknown>>;
}

/** The session-based (no parked cookie) counterpart of captureAction. */
async function captureSessionAction(cookies: ReturnType<typeof makeCookies>, fields: Record<string, string>) {
	try {
		return (await actions.default({
			cookies,
			request: consentRequest(fields),
			url: new URL('http://localhost/consent'),
			getClientAddress: () => '203.0.113.7',
			locals: { user: TEST_OWNER }
		} as never)) as { status: number } | undefined;
	} catch (e) {
		return e as { status: number; location?: string };
	}
}

test('load with a signed-in user and no current consent renders the existing-user flow without a parked cookie', async () => {
	await seedOwner();
	const data = await consentLoadWithSession(makeCookies(), 'http://localhost/consent');
	expect(data).toMatchObject({
		kind: 'existing',
		displayName: null,
		consentText: CONSENT_CHECKBOX_TEXT,
		refundText: REFUND_NOTICE_TEXT
	});
});

test('load with a signed-in user whose consent is current redirects to /dashboard', async () => {
	await seedOwner();
	await seedConsent(TEST_OWNER.id, undefined, LEGAL_VERSION);
	try {
		await consentLoadWithSession(makeCookies(), 'http://localhost/consent');
		expect.unreachable('load should redirect');
	} catch (e) {
		expect(e).toMatchObject({ status: 302, location: '/dashboard' });
	}
});

test('a parked identity takes precedence over the signed-in session', async () => {
	await seedOwner();
	// TEST_OWNER has no consent row — if the session path won, this would
	// render kind 'existing'. The parked flow must render its own identity.
	const data = await consentLoadWithSession(
		cookiesWithPending(NEW_SUB),
		'http://localhost/consent?state=state-1'
	);
	expect(data).toMatchObject({ kind: 'new', displayName: 'One' });
});

test('a signed-in user re-consents in place: consent row written, NO new session issued', async () => {
	await seedOwner();
	const cookies = makeCookies();

	const thrown = await captureSessionAction(cookies, { consent: 'on' });

	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		userId: TEST_OWNER.id,
		email: TEST_OWNER.email,
		docVersion: LEGAL_VERSION,
		checkboxText: CONSENT_CHECKBOX_TEXT,
		ip: '203.0.113.7',
		userAgent: 'moderaty-test/1.0',
		marketingOptIn: 0
	});
	// The live session keeps sliding — re-consent must not issue another one.
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(0);
	expect(cookies.setCalls.find((c) => c.name === 'moderaty_session')).toBeUndefined();
});

test('a signed-in re-consent without the required checkbox fails with 400 and writes nothing', async () => {
	await seedOwner();
	const res = await captureSessionAction(makeCookies(), {});
	expect(res).toMatchObject({ status: 400 });
	expect(await testDb().db.select().from(consents).all()).toHaveLength(0);
});
