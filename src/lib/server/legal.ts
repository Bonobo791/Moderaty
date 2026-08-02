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

// Legal consent constants and the pending-consent cookie that carries a
// Google-verified identity from the OAuth callback to the /consent
// interstitial. The contract forms at the checkbox, not at the OAuth click —
// no account, session, or comment data exists before acceptance.

import type { Cookies } from '@sveltejs/kit';

import { decrypt, encrypt } from '$lib/server/crypto';
import { cookieSecure } from '$lib/server/oauthState';

/**
 * Version of the legal document bundle (Terms of Service, Privacy Policy,
 * Data Processing Agreement). The label is declared with the documents
 * themselves in src/lib/landing/legal.ts and re-exported here so the consent
 * log names the exact document version the user saw. Bump on ANY material
 * change: every user whose latest consent row predates the new version
 * re-accepts at next login.
 */
export { LEGAL_VERSION } from '$lib/landing/legal';

/**
 * The exact text of the required consent checkbox, stored verbatim in each
 * consent row. The 18+ self-declaration lives here on purpose: Google OAuth
 * is identity, not age verification, so this declaration is the documented
 * age gate.
 */
export const CONSENT_CHECKBOX_TEXT =
	'I am at least 18 years old and agree to the Terms of Service, Privacy Policy, and Data Processing Agreement';

/**
 * Marketing e-mail opt-in. Must stay its own unticked box — an LGPD consent
 * bundled into the contract checkbox is invalid.
 */
export const MARKETING_CHECKBOX_TEXT =
	'Send me occasional product updates and moderation tips by e-mail (optional)';

/**
 * Refund notice shown on the consent page, below the form. Mirrors Terms §7
 * (maintainer-directed, PR #38 review): CDC Art. 49 withdrawal covers a full
 * refund within 7 days of purchase. The post-window finality (Terms §7.2-7.3)
 * is deliberately NOT repeated here — it lives only in the Terms and other
 * legally required places. Kept OUT of CONSENT_CHECKBOX_TEXT
 * on purpose: the checkbox sentence is an evidentiary artifact logged
 * verbatim per consent row and never changes without a doc-version bump.
 */
export const REFUND_NOTICE_TEXT =
	'Every purchase is covered by Brazilian consumer law: you have 7 days from purchase to request a full refund of everything you paid, no deductions, no questions asked (CDC Art. 49).';

export const PENDING_CONSENT_COOKIE = 'moderaty_consent_pending';
const PENDING_TTL_MS = 10 * 60 * 1000;
// Bounds the cookie; a user realistically has one or two tabs mid-flow. Same
// collision class as the multi-state OAuth cookie (PR #4): each parked
// identity is keyed by its flow's state so concurrent tabs/accounts never
// overwrite one another.
const MAX_PENDING_CONSENTS = 5;

/** Identity parked between the OAuth callback and the consent interstitial. */
export type PendingConsent =
	| { kind: 'new'; sub: string; email: string; displayName: string }
	| { kind: 'existing'; userId: string };

type PendingEntry = PendingConsent & { state: string; ts: number };

function readEntries(cookies: Cookies): PendingEntry[] {
	const raw = cookies.get(PENDING_CONSENT_COOKIE);
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(decrypt(raw));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(
		(e): e is PendingEntry =>
			typeof e === 'object' && e !== null && typeof (e as PendingEntry).state === 'string'
	) as PendingEntry[];
}

function writeEntries(cookies: Cookies, entries: PendingEntry[]): void {
	if (entries.length === 0) {
		cookies.delete(PENDING_CONSENT_COOKIE, { path: '/' });
		return;
	}
	cookies.set(PENDING_CONSENT_COOKIE, encrypt(JSON.stringify(entries)), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: cookieSecure(),
		maxAge: PENDING_TTL_MS / 1000
	});
}

/**
 * Parks a Google-verified identity, keyed by the OAuth state of its flow, in a
 * short-lived encrypted httpOnly cookie. AES-GCM makes the payload tamper-proof
 * and confidential, so account creation claims cannot be forged client-side.
 */
export function parkPendingConsent(cookies: Cookies, state: string, payload: PendingConsent): void {
	const now = Date.now();
	const entries = readEntries(cookies).filter(
		(e) => e.state !== state && now - e.ts <= PENDING_TTL_MS
	);
	entries.push({ ...payload, state, ts: now });
	writeEntries(cookies, entries.slice(-MAX_PENDING_CONSENTS));
}

/**
 * Reads and validates the parked identity for ONE flow. Returns null when the
 * entry is missing, tampered, malformed, or expired — the caller redirects to
 * /login so the flow restarts cleanly. Other flows' entries are untouched.
 */
export function readPendingConsent(cookies: Cookies, state: string): PendingConsent | null {
	const entry = readEntries(cookies).find((e) => e.state === state);
	if (!entry || typeof entry.ts !== 'number' || Date.now() - entry.ts > PENDING_TTL_MS) return null;
	if (entry.kind === 'existing' && typeof entry.userId === 'string' && entry.userId) {
		return { kind: 'existing', userId: entry.userId };
	}
	if (
		entry.kind === 'new' &&
		typeof entry.sub === 'string' &&
		entry.sub &&
		typeof entry.email === 'string' &&
		entry.email &&
		typeof entry.displayName === 'string' &&
		entry.displayName
	) {
		return { kind: 'new', sub: entry.sub, email: entry.email, displayName: entry.displayName };
	}
	return null;
}

/** Clears only this flow's parked identity once its consent flow completes. */
export function clearPendingConsent(cookies: Cookies, state: string): void {
	writeEntries(
		cookies,
		readEntries(cookies).filter((e) => e.state !== state)
	);
}
