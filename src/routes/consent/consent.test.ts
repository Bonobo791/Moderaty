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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { expect, test, vi } from 'vitest';

import { eq } from 'drizzle-orm';

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
	PRIVACY_NOTICE_TEXT,
	REFUND_NOTICE_TEXT,
	parkPendingConsent,
	type PendingConsent
} from '$lib/server/legal';
import { createSession, getSessionUser, type SessionUser } from '$lib/server/session';

import { actions, load } from './+page.server';

setupTestDb(['consents', 'sessions', 'users', 'channels', 'organizations', 'memberships']);

const here = dirname(fileURLToPath(import.meta.url));
const consentPage = readFileSync(join(here, '+page.svelte'), 'utf8');

function cookiesWithPending(payload: PendingConsent, state = 'state-1') {
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, state, payload);
	return cookies;
}

/** Seeds the users row matching TEST_OWNER. */
async function seedOwner() {
	await testDb()
		.db.insert(users)
		.values({ id: TEST_OWNER.id, googleSub: 'sub-1', email: TEST_OWNER.email, displayName: TEST_OWNER.displayName });
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

/**
 * Calls the page action and captures the outcome: fail() returns an
 * ActionFailure ({ status, data }); redirect/error throw. Parked-cookie
 * flows pass their state; signed-in session flows pass withSession (no
 * state — there is no parked cookie).
 */
async function captureAction(
	cookies: ReturnType<typeof makeCookies>,
	fields: Record<string, string>,
	opts: { state?: string; withSession?: boolean; user?: SessionUser } = {}
) {
	try {
		return (await actions.default({
			cookies,
			request: consentRequest(fields),
			url: new URL(`http://localhost/consent${opts.state ? `?state=${opts.state}` : ''}`),
			getClientAddress: () => '203.0.113.7',
			...(opts.withSession ? { locals: { user: opts.user ?? TEST_OWNER } } : {})
		} as never)) as
			| { status: number }
			| undefined;
	} catch (e) {
		return e as { status: number; location?: string };
	}
}

/** The session-based (no parked cookie) counterpart of a parked captureAction call. */
function captureSessionAction(cookies: ReturnType<typeof makeCookies>, fields: Record<string, string>) {
	return captureAction(cookies, fields, { withSession: true });
}

/** Calls the page load; signed-in session flows pass withSession. */
function loadConsent(cookies: ReturnType<typeof makeCookies>, url: string, withSession = false) {
	return load({
		cookies,
		url: new URL(url),
		...(withSession ? { locals: { user: TEST_OWNER } } : {})
	} as never) as Promise<Record<string, unknown>>;
}

const NEW_SUB: PendingConsent = { kind: 'new', sub: 'sub-1', email: 'one@example.com', displayName: 'One' };

async function expectLoadRedirectsToLogin(cookies: ReturnType<typeof makeCookies>, url: string) {
	try {
		await loadConsent(cookies, url);
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
	const data = await loadConsent(cookiesWithPending(NEW_SUB), 'http://localhost/consent?state=state-1');
	expect(data).toMatchObject({ consentText: CONSENT_CHECKBOX_TEXT, kind: 'new', displayName: 'One' });
});

test('load also hands every flow the refund and privacy notices, outside the evidentiary checkbox text', async () => {
	// The refund notice is consumer-rights copy (Terms §7, CDC Art. 49) and the
	// privacy notice is consumer-trust copy (Privacy Policy §2, LGPD Art. 16,
	// III) — neither is part of the logged consent sentence:
	// CONSENT_CHECKBOX_TEXT must stay byte-identical so existing consent rows
	// keep matching what was shown.
	expect(CONSENT_CHECKBOX_TEXT).toBe(
		'I am at least 18 years old and agree to the Terms of Service, Privacy Policy, and Data Processing Agreement'
	);
	for (const notice of [REFUND_NOTICE_TEXT, PRIVACY_NOTICE_TEXT]) {
		expect(notice).not.toContain(CONSENT_CHECKBOX_TEXT);
	}
	expect(REFUND_NOTICE_TEXT).toContain('CDC Art. 49');
	expect(PRIVACY_NOTICE_TEXT).toContain('LGPD');
	const parked = await loadConsent(cookiesWithPending(NEW_SUB), 'http://localhost/consent?state=state-1');
	expect(parked).toMatchObject({ refundText: REFUND_NOTICE_TEXT, privacyText: PRIVACY_NOTICE_TEXT });
	await seedOwner();
	const session = await loadConsent(makeCookies(), 'http://localhost/consent', true);
	expect(session).toMatchObject({ privacyText: PRIVACY_NOTICE_TEXT });
	expect(consentPage).toContain('data.privacyText');
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
	const res = (await captureAction(makeCookies(), { consent: 'on' }, { state: 'state-1' })) as {
		status: number;
		data?: { error?: string };
	};
	expect(res.status).toBe(400);
	// The rejection tells the user exactly how to recover — sign in again.
	expect(res.data?.error).toBe('Your sign-in session expired — please sign in again.');
	await expectNothingWritten();
});

test('action without the required checkbox fails with 400 and writes nothing', async () => {
	const res = await captureAction(cookiesWithPending(NEW_SUB), {}, { state: 'state-1' });
	expect(res).toMatchObject({ status: 400 });
	await expectNothingWritten();
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(0);
});

test('a new user is created only at acceptance, with a full evidentiary consent record', async () => {
	const cookies = cookiesWithPending(NEW_SUB);

	const thrown = await captureAction(cookies, { consent: 'on' }, { state: 'state-1' });

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
	const thrown = await captureAction(cookiesWithPending(NEW_SUB), { consent: 'on' }, { state: 'state-1' });
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
	await captureAction(cookiesWithPending(NEW_SUB), { consent: 'on', marketing: 'on' }, { state: 'state-1' });

	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toHaveLength(1);
	expect(rows[0].marketingOptIn).toBe(1);
});

test('only the first-ever user claims orphaned channels', async () => {
	await testDb().db.insert(channels).values({ id: 'UC1', title: 'Old', refreshTokenEnc: 'enc', active: 1, createdAt: '2026-01-01T00:00:00.000Z' });
	await captureAction(cookiesWithPending(NEW_SUB), { consent: 'on' }, { state: 'state-1' });
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
	const second = await captureAction(cookiesWithPending({ kind: 'new', sub: 'sub-2', email: 'two@example.com', displayName: 'Two' }), { consent: 'on' }, { state: 'state-1' });
	expect(second).toMatchObject({ status: 302, location: '/dashboard' });
	expect((await testDb().db.select().from(users).all()).map((u) => u.googleSub)).toContain('sub-2');

	const unclaimed = (await testDb().db.select().from(channels).all()).find((c) => c.id === 'UC2')!;
	expect(unclaimed.userId).toBeNull();
	expect(unclaimed.orgId).toBeNull();
});

/** Seeds existing sub-1 and completes its re-consent. */
async function seedExistingAndConsent() {
	await seedOwner();
	const thrown = await captureAction(cookiesWithPending({ kind: 'existing', userId: 'user-1' }), { consent: 'on' }, { state: 'state-1' });
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

	// The e-mail is recorded from the users row — statutory-retention evidence
	// (Art. 16, III), since account deletion wipes users.email entirely.
	const row = await testDb().db.select().from(consents).where(eq(consents.userId, 'user-1')).get();
	expect(row).toMatchObject({ email: 'one@example.com', docVersion: LEGAL_VERSION });
	await expectOneConsentedAccount();
});

test('an existing-user pending payload naming an unknown account fails with 400', async () => {
	const res = (await captureAction(cookiesWithPending({ kind: 'existing', userId: 'ghost' }), { consent: 'on' }, { state: 'state-1' })) as {
		status: number;
		data?: { error?: string };
	};
	expect(res.status).toBe(400);
	expect(res.data?.error).toBe('Your sign-in session expired — please sign in again.');
	expect(await testDb().db.select().from(consents).all()).toHaveLength(0);
});

test('a parked existing identity renders the existing flow with no display name', async () => {
	// Only the new-account payload carries a Google display name; the
	// re-acceptance flow must render displayName null, not leak undefined.
	const data = await loadConsent(
		cookiesWithPending({ kind: 'existing', userId: 'user-1' }),
		'http://localhost/consent?state=state-1'
	);
	expect(data.kind).toBe('existing');
	expect(data.displayName).toBeNull();
});

test('acceptance writes the session cookie httpOnly, lax, path-scoped, and expiring with the session', async () => {
	const cookies = cookiesWithPending(NEW_SUB);
	const thrown = await captureAction(cookies, { consent: 'on' }, { state: 'state-1' });
	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });

	const session = (await testDb().db.select().from(sessions).all())[0];
	const call = cookies.setCalls.find((c) => c.name === 'moderaty_session');
	expect(call).toBeTruthy();
	expect(call!.value).toBe(session.id);
	// APP_URL is http in tests, so Secure is off; the rest are hard requirements.
	expect(call!.opts).toEqual({
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: false,
		expires: new Date(session.expiresAt)
	});
});

test('a request without a user-agent header records an empty user-agent string', async () => {
	// The evidentiary row must not store null/undefined when the header is
	// absent — it records the empty string.
	const form = new FormData();
	form.set('consent', 'on');
	let thrown: unknown;
	try {
		await actions.default({
			cookies: cookiesWithPending(NEW_SUB),
			request: new Request('http://localhost/consent', { method: 'POST', body: form }),
			url: new URL('http://localhost/consent?state=state-1'),
			getClientAddress: () => '203.0.113.7'
		} as never);
	} catch (e) {
		thrown = e;
	}
	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	const rows = await testDb().db.select().from(consents).all();
	expect(rows).toHaveLength(1);
	expect(rows[0].userAgent).toBe('');
});

test('a pending identity parked under a different state is invisible to this flow', async () => {
	const res = await captureAction(cookiesWithPending(NEW_SUB, 'state-a'), { consent: 'on' }, { state: 'state-b' });
	expect(res).toMatchObject({ status: 400 });
	await expectNothingWritten();
});

test('a session-creation failure rolls back the account and consent, leaving the flow retryable', async () => {
	vi.mocked(createSession).mockRejectedValueOnce(new Error('sessions table unavailable'));
	const cookies = cookiesWithPending(NEW_SUB);

	const failed = await captureAction(cookies, { consent: 'on' }, { state: 'state-1' });
	expect(failed).toBeInstanceOf(Error);
	// Nothing committed: the user, consent, and session writes are one unit.
	await expectNothingWritten();
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(0);

	// The pending cookie was never consumed, so the same submission retries clean.
	const retried = await captureAction(cookies, { consent: 'on' }, { state: 'state-1' });
	expect(retried).toMatchObject({ status: 302, location: '/dashboard' });
	await expectOneConsentedAccount();
});

test('concurrent flows are isolated by state — each tab consents its own identity', async () => {
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, 'state-a', NEW_SUB);
	parkPendingConsent(cookies as never, 'state-b', { kind: 'new', sub: 'sub-2', email: 'two@example.com', displayName: 'Two' });

	// Tab B submits first: only sub-2's account is created.
	const first = await captureAction(cookies, { consent: 'on' }, { state: 'state-b' });
	expect(first).toMatchObject({ status: 302, location: '/dashboard' });
	const afterFirst = await testDb().db.select().from(users).all();
	expect(afterFirst).toHaveLength(1);
	expect(afterFirst[0].googleSub).toBe('sub-2');

	// Tab A's parked identity survived the overwrite attempt and still
	// consents its own intended account.
	const second = await captureAction(cookies, { consent: 'on' }, { state: 'state-a' });
	expect(second).toMatchObject({ status: 302, location: '/dashboard' });
	const all = await testDb().db.select().from(users).all();
	expect(all.map((u) => u.googleSub).sort()).toEqual(['sub-1', 'sub-2']);
	// Both entries consumed — the cookie itself is gone.
	expect(cookies.get(PENDING_CONSENT_COOKIE)).toBeUndefined();
});

// --- Signed-in re-consent: legal docs updated while a session was still ---
// --- sliding, so the (app) layout gate sent the user here without a      ---
// --- parked cookie.                                                      ---

test('load with a signed-in user and no current consent renders the existing-user flow without a parked cookie', async () => {
	await seedOwner();
	const data = await loadConsent(makeCookies(), 'http://localhost/consent', true);
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
		await loadConsent(makeCookies(), 'http://localhost/consent', true);
		expect.unreachable('load should redirect');
	} catch (e) {
		expect(e).toMatchObject({ status: 302, location: '/dashboard' });
	}
});

test('a parked new-identity flow is NOT rendered to a different signed-in user (CodeRabbit 3738037988)', async () => {
	await seedOwner();
	// Shared browser: TEST_OWNER is signed in, but the parked 'new' flow
	// belongs to a Google account that does not exist yet — never render (or
	// leak the displayName of) someone else's parked identity.
	try {
		await loadConsent(cookiesWithPending(NEW_SUB), 'http://localhost/consent?state=state-1', true);
		expect.unreachable('load must reject a parked flow owned by a different user');
	} catch (e) {
		expect(e).toMatchObject({
			status: 400,
			body: { message: 'This sign-in is for a different account — sign out and start again.' }
		});
	}
});

test('a parked identity is rendered to its OWN signed-in user', async () => {
	await seedOwner();
	// Control: the same user who parked the flow sees it — the load guard must
	// only fire on a mismatch.
	const data = await loadConsent(
		cookiesWithPending({ kind: 'existing', userId: TEST_OWNER.id }),
		'http://localhost/consent?state=state-1',
		true
	);
	expect(data).toMatchObject({ kind: 'existing' });
});

test('a signed-in user re-consents in place: consent row written, NO new session issued', async () => {
	await seedOwner();
	// An existing live session must survive re-consent untouched — an empty
	// table cannot distinguish "no new session" from "session wiped".
	await testDb()
		.db.insert(sessions)
		.values({ id: 'sess-live', userId: TEST_OWNER.id, expiresAt: '2027-01-01T00:00:00.000Z' });
	const cookies = makeCookies();

	const thrown = await captureSessionAction(cookies, { consent: 'on' });

	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	// Exactly one consent row, attributable to this user with full evidence.
	const row = await testDb().db.select().from(consents).where(eq(consents.userId, TEST_OWNER.id)).get();
	expect(row).toMatchObject({
		email: TEST_OWNER.email,
		docVersion: LEGAL_VERSION,
		checkboxText: CONSENT_CHECKBOX_TEXT,
		ip: '203.0.113.7',
		userAgent: 'moderaty-test/1.0',
		marketingOptIn: 0
	});
	// The live session keeps sliding — re-consent must not issue another one,
	// and the pre-existing session row is untouched.
	const allSessions = await testDb().db.select().from(sessions).all();
	expect(allSessions).toHaveLength(1);
	expect(allSessions[0].id).toBe('sess-live');
	expect(cookies.setCalls.find((c) => c.name === 'moderaty_session')).toBeUndefined();
});

test('a signed-in user whose consent is already current adds NO duplicate row on a direct POST', async () => {
	await seedOwner();
	await seedConsent(TEST_OWNER.id, undefined, LEGAL_VERSION);
	const thrown = await captureSessionAction(makeCookies(), { consent: 'on' });
	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	// Still exactly the seeded row — the append-only log gains no duplicate.
	expect(await testDb().db.select().from(consents).all()).toHaveLength(1);
});

test('a signed-in re-consent without the required checkbox fails with 400 and writes nothing', async () => {
	await seedOwner();
	const res = (await captureSessionAction(makeCookies(), {})) as { status: number; data?: { error?: string } };
	expect(res.status).toBe(400);
	// The rejection names the obligation — no silent generic failure.
	expect(res.data?.error).toContain('at least 18');
	expect(await testDb().db.select().from(consents).all()).toHaveLength(0);
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(0);
});

test('a parked existing-identity flow is rejected when a DIFFERENT user is signed in (shared browser)', async () => {
	// Hardening: user B, signed in on a shared machine, must not complete user
	// A's parked consent — doing so would mint a session AS A in B's browser.
	await seedOwner();
	const other: SessionUser = { ...TEST_OWNER, id: 'user-b', email: 'b@example.com' };
	const cookies = cookiesWithPending({ kind: 'existing', userId: TEST_OWNER.id });

	const res = (await captureAction(cookies, { consent: 'on' }, { state: 'state-1', withSession: true, user: other })) as {
		status: number;
		data?: { error?: string };
	};

	expect(res.status).toBe(400);
	expect(res.data?.error).toContain('different account');
	// Nothing was written — no consent row for A, no session minted as A.
	expect(await testDb().db.select().from(consents).all()).toHaveLength(0);
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(0);
});

test('a parked new-identity flow is rejected while ANY user is signed in (shared browser)', async () => {
	await seedOwner();
	const cookies = cookiesWithPending({ kind: 'new', sub: 'sub-new', email: 'new@example.com', displayName: 'New' });

	const res = (await captureAction(cookies, { consent: 'on' }, { state: 'state-1', withSession: true })) as {
		status: number;
		data?: { error?: string };
	};

	expect(res.status).toBe(400);
	expect(res.data?.error).toContain('different account');
	// A parked 'new' identity is a Google account that does not exist yet — a
	// signed-in session can never be the same account, so no account is created.
	expect(await testDb().db.select().from(users).where(eq(users.googleSub, 'sub-new')).all()).toHaveLength(0);
	expect(await testDb().db.select().from(consents).all()).toHaveLength(0);
	expect(await testDb().db.select().from(sessions).all()).toHaveLength(0);
});

test('a parked identity completed by its OWN signed-in user is still accepted', async () => {
	// Control: the same user who parked the flow may complete it while signed
	// in (their session id matches the parked userId) — the shared-browser
	// guard must not reject the legitimate owner.
	await seedOwner();
	const cookies = cookiesWithPending({ kind: 'existing', userId: TEST_OWNER.id });

	const thrown = await captureAction(cookies, { consent: 'on' }, { state: 'state-1', withSession: true });

	expect(thrown).toMatchObject({ status: 302, location: '/dashboard' });
	expect(await testDb().db.select().from(consents).all()).toHaveLength(1);
});
