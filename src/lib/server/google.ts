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

// Shared Google OAuth plumbing for the identity login flow and the YouTube
// channel-connect flow.

import { error } from '@sveltejs/kit';

import { env } from '$env/dynamic/private';

export interface GoogleTokens {
	accessToken: string;
	refreshToken?: string;
}

/**
 * Exchanges an authorization code for tokens at Google's token endpoint.
 *
 * Failures are logged server-side with redacted detail; the client only ever
 * sees `userError` — never tokens (AGENTS.md). The authorization code is
 * one-time use, so this exchange must not retry: a retried request after a
 * transient timeout would fail the sign-in.
 *
 * @param code - The authorization code from the OAuth callback.
 * @param redirectPath - The callback path registered for this flow (must match the auth request).
 * @param logPrefix - Server-log prefix identifying the flow (e.g. 'google login token exchange').
 * @param userError - The generic 502 message shown to the user on upstream failure.
 * @returns The validated tokens (access token always present; refresh token when Google sends one).
 */
export async function exchangeGoogleCode(
	code: string,
	redirectPath: string,
	logPrefix: string,
	userError: string
): Promise<GoogleTokens> {
	if (!env.GOOGLE_CLIENT_ID) throw error(500, 'GOOGLE_CLIENT_ID is not configured');
	if (!env.GOOGLE_CLIENT_SECRET) throw error(500, 'GOOGLE_CLIENT_SECRET is not configured');
	if (!env.APP_URL) throw error(500, 'APP_URL is not configured');

	let tokenRes: Response;
	let tokenText: string;
	try {
		tokenRes = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				code,
				client_id: env.GOOGLE_CLIENT_ID,
				client_secret: env.GOOGLE_CLIENT_SECRET,
				redirect_uri: new URL(redirectPath, env.APP_URL).toString(),
				grant_type: 'authorization_code'
			}),
			signal: AbortSignal.timeout(10_000)
		});
		tokenText = await tokenRes.text();
	} catch (e) {
		console.error(`${logPrefix} request failed: ${e instanceof Error ? e.message : e}`);
		throw error(502, userError);
	}
	let tokens: {
		access_token?: unknown;
		refresh_token?: unknown;
		error?: unknown;
		error_description?: unknown;
	};
	try {
		tokens = JSON.parse(tokenText) as typeof tokens;
	} catch {
		console.error(`${logPrefix} returned invalid JSON: ${tokenRes.status}`);
		throw error(502, 'invalid response from Google — please retry');
	}
	if (typeof tokens !== 'object' || tokens === null) {
		console.error(`${logPrefix} returned a non-object body: ${tokenRes.status}`);
		throw error(502, 'invalid response from Google — please retry');
	}
	if (!tokenRes.ok) {
		// Upstream failure, not a user error. Log only status and Google's
		// non-secret error fields — never the raw body, which may carry tokens.
		const detail =
			typeof tokens.error === 'string'
				? `${tokens.error}${typeof tokens.error_description === 'string' ? `: ${tokens.error_description}` : ''}`
				: 'no error detail';
		console.error(`${logPrefix} failed: ${tokenRes.status} ${detail}`);
		throw error(502, userError);
	}
	if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
		console.error(`${logPrefix} returned 200 without an access_token`);
		throw error(502, 'invalid response from Google — please retry');
	}
	return {
		accessToken: tokens.access_token,
		refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : undefined
	};
}
