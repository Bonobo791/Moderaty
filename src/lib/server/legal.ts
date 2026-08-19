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

// Legal consent constants and the pending-consent cookie that carries a
// Google-verified identity from the OAuth callback to the /consent
// interstitial. The contract forms at the checkbox, not at the OAuth click —
// no account, session, or comment data exists before acceptance.

import type { Cookies } from '@sveltejs/kit';

import { and, eq } from 'drizzle-orm';

import { decrypt, encrypt } from '$lib/server/crypto';
import { db } from '$lib/server/db';
import { consents } from '$lib/server/db/schema';
import { cookieSecure } from '$lib/server/oauthState';

/**
 * Version of the legal document bundle (Terms of Service, Privacy Policy,
 * Data Processing Agreement). The label is declared with the documents
 * themselves in src/lib/landing/legal.ts and re-exported here so the consent
 * log names the exact document version the user saw. Bump on ANY material
 * change: every user whose latest consent row predates the new version
 * re-accepts at next login — and, via the (app) layout gate, at their next
 * page load if they are still signed in when the bump deploys.
 */
import { LEGAL_VERSION } from '$lib/landing/legal';

export { LEGAL_VERSION };

/**
 * The exact text of the required consent checkbox, stored verbatim in each
 * consent row. The 18+ self-declaration lives here on purpose: Google OAuth
 * is identity, not age verification, so this declaration is the documented
 * age gate.
 */
export const CONSENT_CHECKBOX_TEXT =
	'I am at least 18 years old and agree to the Terms of Service, Privacy Policy, and Data Processing Agreement';

/**
 * Auto top-up consent (Terms §6.2). Stripe's compliance requirements for
 * off-session charging demand explicit consent for "unscheduled top-ups" —
 * this exact sentence is the unticked checkbox on the Usage page, and
 * legal.test.ts pins it against Terms §6.2 so the form can never drift from
 * the logged terms.
 */
export const AUTO_TOPUP_CONSENT_TEXT =
	'I authorize Moderaty to charge my saved payment method for comment-credit bundles automatically whenever my balance drops below the threshold I set (unscheduled top-ups, per Section 6 of the Terms of Service).';

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

/**
 * Privacy notice shown beside REFUND_NOTICE_TEXT on the consent page. The
 * claim is scoped on purpose — account data IS stored while the account
 * exists (Privacy Policy §2) — so the honest line is "nothing beyond what
 * your account needs to run" plus the one statutory keep (LGPD Art. 16, III).
 * Scoping is enforced by the consistency guard in src/lib/landing/legal.test.ts.
 */
export const PRIVACY_NOTICE_TEXT =
	'Privacy, in one sentence: Moderaty stores nothing about you beyond what your account needs to run, and we never sell or profile your data. The one record we keep by law is this consent acceptance itself (LGPD Art. 16, III).';

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
	// Stryker disable next-line ConditionalExpression: equivalent — without the guard, decrypt(undefined/'') throws and the catch below returns the same []
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(decrypt(raw));
	}
	// Stryker disable next-line BlockStatement: equivalent — an empty catch leaves parsed undefined, and the Array.isArray check below returns the same []
	catch {
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

/**
 * True when the user has a consent row matching the current LEGAL_VERSION.
 * One check, three gates: the login callback (park or session), the (app)
 * layout (re-consent redirect for still-active sessions after a doc bump),
 * and /consent itself (a current user goes straight to /dashboard).
 */
export async function hasCurrentConsent(userId: string): Promise<boolean> {
	const row = await db
		.select({ id: consents.id })
		.from(consents)
		.where(and(eq(consents.userId, userId), eq(consents.docVersion, LEGAL_VERSION)))
		.get();
	return row !== undefined;
}
