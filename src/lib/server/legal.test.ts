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

import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {
		APP_URL: 'https://moderaty.example',
		ENCRYPTION_KEY: 'test-encryption-key'
	} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { decrypt, encrypt } from './crypto';
import {
	PENDING_CONSENT_COOKIE,
	clearPendingConsent,
	parkPendingConsent,
	readPendingConsent,
	type PendingConsent
} from './legal';
import { makeCookies } from './testcookies';

type Cookies = ReturnType<typeof makeCookies>;

const NEW_SUB: PendingConsent = { kind: 'new', sub: 'sub-1', email: 'one@example.com', displayName: 'One' };
const EXISTING: PendingConsent = { kind: 'existing', userId: 'user-1' };
// Mirrors PENDING_TTL_MS in legal.ts; pinned by the maxAge assertion below.
const TTL_MS = 10 * 60 * 1000;

/** Decrypts the pending-consent cookie into its raw parked entries. */
function parkedEntries(cookies: Cookies): Array<Record<string, unknown>> {
	const raw = cookies.get(PENDING_CONSENT_COOKIE);
	expect(raw, 'pending cookie should be set').toBeTruthy();
	return JSON.parse(decrypt(raw as string));
}

/** Seeds the cookie directly with crafted entries (bypasses park validation). */
function seedEntries(cookies: Cookies, entries: Array<Record<string, unknown>>): void {
	cookies.set(PENDING_CONSENT_COOKIE, encrypt(JSON.stringify(entries)), { path: '/' });
}

/** A valid raw entry shell with fresh state/ts, overridable per test. */
function rawEntry(overrides: Record<string, unknown>): Record<string, unknown> {
	return { state: 'state-1', ts: Date.now(), ...overrides };
}

afterEach(() => {
	vi.useRealTimers();
});

test('park writes an encrypted httpOnly cookie with path, SameSite=Lax, Secure, and a 600s maxAge', () => {
	const cookies = makeCookies();

	parkPendingConsent(cookies as never, 'state-1', NEW_SUB);

	const call = cookies.setCalls.find((c) => c.name === PENDING_CONSENT_COOKIE);
	expect(call).toBeTruthy();
	expect(call?.opts).toEqual({
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: true,
		maxAge: 600
	});
	// The payload is ciphertext, not readable JSON.
	expect(() => JSON.parse(call?.value as string)).toThrow();
});

test('a parked new identity round-trips exactly, without the flow state or timestamp', () => {
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, 'state-1', NEW_SUB);

	expect(readPendingConsent(cookies as never, 'state-1')).toEqual({
		kind: 'new',
		sub: 'sub-1',
		email: 'one@example.com',
		displayName: 'One'
	});
});

test('a parked existing-user identity round-trips with kind "existing"', () => {
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, 'state-1', EXISTING);

	expect(readPendingConsent(cookies as never, 'state-1')).toEqual({ kind: 'existing', userId: 'user-1' });
});

test('reading a state that was never parked returns null and leaves the parked entry intact', () => {
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, 'state-a', NEW_SUB);

	expect(readPendingConsent(cookies as never, 'state-b')).toBeNull();
	expect(readPendingConsent(cookies as never, 'state-a')).toEqual(NEW_SUB);
});

test('clearing removes only the target flow; removing the last entry deletes the cookie at path /', () => {
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, 'state-a', NEW_SUB);
	parkPendingConsent(cookies as never, 'state-b', EXISTING);

	clearPendingConsent(cookies as never, 'state-a');

	expect(readPendingConsent(cookies as never, 'state-a')).toBeNull();
	expect(readPendingConsent(cookies as never, 'state-b')).toEqual(EXISTING);
	expect(cookies.deleteCalls).toHaveLength(0);

	clearPendingConsent(cookies as never, 'state-b');

	expect(cookies.deleteCalls).toContainEqual({ name: PENDING_CONSENT_COOKIE, opts: { path: '/' } });
	expect(cookies.get(PENDING_CONSENT_COOKIE)).toBeUndefined();
});

test('clearing with no cookie present deletes rather than writing a new cookie', () => {
	const cookies = makeCookies();

	clearPendingConsent(cookies as never, 'state-x');

	expect(cookies.deleteCalls).toContainEqual({ name: PENDING_CONSENT_COOKIE, opts: { path: '/' } });
	expect(cookies.setCalls.find((c) => c.name === PENDING_CONSENT_COOKIE)).toBeUndefined();
	expect(cookies.get(PENDING_CONSENT_COOKIE)).toBeUndefined();
});

test('a tampered cookie reads as null and clears to a deletion, never a rewrite', () => {
	const cookies = makeCookies();
	cookies.set(PENDING_CONSENT_COOKIE, 'forged-ciphertext', { path: '/' });

	expect(readPendingConsent(cookies as never, 'state-1')).toBeNull();

	clearPendingConsent(cookies as never, 'state-1');
	expect(cookies.deleteCalls).toContainEqual({ name: PENDING_CONSENT_COOKIE, opts: { path: '/' } });
	expect(cookies.get(PENDING_CONSENT_COOKIE)).toBeUndefined();
});

test('a cookie whose decrypted payload is valid JSON but not an array reads as null', () => {
	const cookies = makeCookies();
	cookies.set(PENDING_CONSENT_COOKIE, encrypt(JSON.stringify({ state: 'state-1' })), { path: '/' });

	expect(readPendingConsent(cookies as never, 'state-1')).toBeNull();

	clearPendingConsent(cookies as never, 'state-1');
	expect(cookies.get(PENDING_CONSENT_COOKIE)).toBeUndefined();
});

test('entries without a string state are dropped when reading the cookie', () => {
	const cookies = makeCookies();
	seedEntries(cookies, [{ state: 42, ts: Date.now(), kind: 'existing', userId: 'user-1' }]);

	expect(readPendingConsent(cookies as never, '42')).toBeNull();
	// The invalid entry does not survive a park round-trip either.
	parkPendingConsent(cookies as never, 'state-1', NEW_SUB);
	expect(parkedEntries(cookies)).toHaveLength(1);
});

test('parking a state that is already parked replaces the old entry instead of duplicating it', () => {
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, 'state-1', NEW_SUB);
	parkPendingConsent(cookies as never, 'state-1', EXISTING);

	const entries = parkedEntries(cookies);
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({ state: 'state-1', kind: 'existing', userId: 'user-1' });
	expect(readPendingConsent(cookies as never, 'state-1')).toEqual(EXISTING);
});

test('parking drops entries older than the TTL instead of carrying them forward', () => {
	const cookies = makeCookies();
	seedEntries(cookies, [rawEntry({ state: 'state-old', ts: Date.now() - TTL_MS - 1000, kind: 'existing', userId: 'user-1' })]);

	parkPendingConsent(cookies as never, 'state-new', NEW_SUB);

	const entries = parkedEntries(cookies);
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({ state: 'state-new' });
});

test('an entry exactly at the TTL boundary is still inside the window when parking', () => {
	vi.useFakeTimers();
	vi.setSystemTime(1_800_000_000_000);
	const cookies = makeCookies();
	seedEntries(cookies, [rawEntry({ state: 'state-edge', ts: Date.now() - TTL_MS, kind: 'existing', userId: 'user-1' })]);

	parkPendingConsent(cookies as never, 'state-new', NEW_SUB);

	const states = parkedEntries(cookies).map((e) => e.state);
	expect(states).toEqual(['state-edge', 'state-new']);
});

test('parking keeps only the newest 5 entries, dropping the oldest first', () => {
	const cookies = makeCookies();
	for (const state of ['s1', 's2', 's3', 's4', 's5', 's6']) {
		parkPendingConsent(cookies as never, state, NEW_SUB);
	}

	const states = parkedEntries(cookies).map((e) => e.state);
	expect(states).toEqual(['s2', 's3', 's4', 's5', 's6']);
});

test('a parked identity expires after the TTL and reads as null', () => {
	vi.useFakeTimers();
	vi.setSystemTime(1_800_000_000_000);
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, 'state-1', NEW_SUB);

	vi.setSystemTime(1_800_000_000_000 + TTL_MS + 1);

	expect(readPendingConsent(cookies as never, 'state-1')).toBeNull();
});

test('a parked identity exactly at the TTL boundary is still readable', () => {
	vi.useFakeTimers();
	vi.setSystemTime(1_800_000_000_000);
	const cookies = makeCookies();
	parkPendingConsent(cookies as never, 'state-1', NEW_SUB);

	vi.setSystemTime(1_800_000_000_000 + TTL_MS);

	expect(readPendingConsent(cookies as never, 'state-1')).toEqual(NEW_SUB);
});

test('an entry with a non-numeric timestamp reads as null', () => {
	const cookies = makeCookies();
	seedEntries(cookies, [rawEntry({ ...EXISTING, ts: 'soon' })]);

	expect(readPendingConsent(cookies as never, 'state-1')).toBeNull();
});

test('an existing-kind entry with a non-string userId reads as null', () => {
	const cookies = makeCookies();
	seedEntries(cookies, [rawEntry({ kind: 'existing', userId: 123 })]);

	expect(readPendingConsent(cookies as never, 'state-1')).toBeNull();
});

test('an existing-kind entry with an empty userId reads as null', () => {
	const cookies = makeCookies();
	seedEntries(cookies, [rawEntry({ kind: 'existing', userId: '' })]);

	expect(readPendingConsent(cookies as never, 'state-1')).toBeNull();
});

test('a new-kind entry that also carries a userId still reads as its own kind', () => {
	// Forgery guard: the kind discriminator decides, not field presence — a
	// crafted entry must not be promoted to an existing-user identity.
	const cookies = makeCookies();
	seedEntries(cookies, [rawEntry({ ...NEW_SUB, userId: 'user-1' })]);

	expect(readPendingConsent(cookies as never, 'state-1')).toEqual(NEW_SUB);
});

test('an existing-kind entry missing a valid userId is not reinterpreted as a new signup', () => {
	const cookies = makeCookies();
	seedEntries(cookies, [rawEntry({ kind: 'existing', userId: 123, sub: 'sub-1', email: 'one@example.com', displayName: 'One' })]);

	expect(readPendingConsent(cookies as never, 'state-1')).toBeNull();
});

test.each([
	['non-string sub', { kind: 'new', sub: 123, email: 'one@example.com', displayName: 'One' }],
	['empty sub', { kind: 'new', sub: '', email: 'one@example.com', displayName: 'One' }],
	['non-string email', { kind: 'new', sub: 'sub-1', email: 123, displayName: 'One' }],
	['empty email', { kind: 'new', sub: 'sub-1', email: '', displayName: 'One' }],
	['non-string displayName', { kind: 'new', sub: 'sub-1', email: 'one@example.com', displayName: 123 }],
	['empty displayName', { kind: 'new', sub: 'sub-1', email: 'one@example.com', displayName: '' }]
])('a new-kind entry with %s reads as null', (_label, entry) => {
	const cookies = makeCookies();
	seedEntries(cookies, [rawEntry(entry)]);

	expect(readPendingConsent(cookies as never, 'state-1')).toBeNull();
});
