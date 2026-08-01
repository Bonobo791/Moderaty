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

export const PENDING_CONSENT_COOKIE = 'moderaty_consent_pending';
const PENDING_TTL_MS = 10 * 60 * 1000;

/** Identity parked between the OAuth callback and the consent interstitial. */
export type PendingConsent =
	| { kind: 'new'; sub: string; email: string; displayName: string }
	| { kind: 'existing'; userId: string };

/**
 * Parks a Google-verified identity in a short-lived encrypted httpOnly cookie.
 * AES-GCM makes the payload tamper-proof and confidential, so account
 * creation claims cannot be forged client-side.
 */
export function parkPendingConsent(cookies: Cookies, payload: PendingConsent): void {
	const wrapped = JSON.stringify({ ...payload, ts: Date.now() });
	cookies.set(PENDING_CONSENT_COOKIE, encrypt(wrapped), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: cookieSecure(),
		maxAge: PENDING_TTL_MS / 1000
	});
}

/**
 * Reads and validates the parked identity. Returns null when the cookie is
 * missing, tampered, malformed, or expired — the caller redirects to /login
 * so the flow restarts cleanly.
 */
export function readPendingConsent(cookies: Cookies): PendingConsent | null {
	const raw = cookies.get(PENDING_CONSENT_COOKIE);
	if (!raw) return null;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(decrypt(raw)) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (typeof parsed?.ts !== 'number' || Date.now() - parsed.ts > PENDING_TTL_MS) return null;
	if (parsed.kind === 'existing' && typeof parsed.userId === 'string' && parsed.userId) {
		return { kind: 'existing', userId: parsed.userId };
	}
	if (
		parsed.kind === 'new' &&
		typeof parsed.sub === 'string' &&
		parsed.sub &&
		typeof parsed.email === 'string' &&
		parsed.email &&
		typeof parsed.displayName === 'string' &&
		parsed.displayName
	) {
		return { kind: 'new', sub: parsed.sub, email: parsed.email, displayName: parsed.displayName };
	}
	return null;
}

/** Clears the parked identity once the account/consent flow completes. */
export function clearPendingConsent(cookies: Cookies): void {
	cookies.delete(PENDING_CONSENT_COOKIE, { path: '/' });
}
