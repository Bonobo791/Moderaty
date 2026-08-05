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

import type { Cookies } from '@sveltejs/kit';

import { error } from '@sveltejs/kit';

import { env } from '$env/dynamic/private';

export const OAUTH_STATE_COOKIE = 'oauth_state';

// Bounds the cookie; a user realistically has one or two tabs mid-flow.
const MAX_PENDING_STATES = 5;

/**
 * The single source of the cookie `Secure` attribute for every cookie the app
 * writes (OAuth state + session). Derived from the configured APP_URL — never
 * from the per-request URL, which a TLS-terminating proxy can misrepresent.
 * A missing APP_URL fails loudly rather than silently dropping `Secure`.
 */
export function cookieSecure(): boolean {
	const appUrl = env.APP_URL;
	if (!appUrl) throw error(500, 'APP_URL is not configured');
	return appUrl.startsWith('https://');
}

/**
 * Reads the pending OAuth states from the cookie. Several states are kept at
 * once so starting the flow in a second tab does not invalidate the first
 * tab's transaction. A missing or malformed cookie reads as no states.
 */
export function readPendingStates(cookies: Cookies): string[] {
	const raw = cookies.get(OAUTH_STATE_COOKIE);
	// Stryker disable next-line ConditionalExpression: equivalent — a falsy cookie value falls through to JSON.parse(raw), which throws and is caught, returning [] identically
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		// Stryker disable next-line ConditionalExpression: equivalent — JSON.parse output that is not an array has no callable .filter, so the TypeError is caught and returns [] identically
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((s): s is string => typeof s === 'string');
	} catch {
		return [];
	}
}

/**
 * Persists the pending states, keeping only the newest MAX_PENDING_STATES, or
 * deletes the cookie when none remain.
 */
export function storePendingStates(cookies: Cookies, states: string[]): void {
	if (states.length === 0) {
		cookies.delete(OAUTH_STATE_COOKIE, { path: '/' });
		return;
	}
	cookies.set(OAUTH_STATE_COOKIE, JSON.stringify(states.slice(-MAX_PENDING_STATES)), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		// The state cookie carries the CSRF guard, so it must never travel over
		// plain HTTP outside local development.
		secure: cookieSecure(),
		maxAge: 600
	});
}
