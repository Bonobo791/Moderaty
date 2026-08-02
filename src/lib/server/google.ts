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
 * POSTs a form body to a Google endpoint and returns the raw response text.
 *
 * Shared failure handling for the token and revocation endpoints: network
 * failures and non-OK statuses are logged server-side with Google's non-secret
 * error fields — never the raw body, which may carry tokens (AGENTS.md) — and
 * `makeError()` produces the caller-specific thrown error. The status is
 * checked before any JSON parsing: a non-OK response with a non-JSON body
 * (e.g. a proxy error page) is an upstream failure, not a parse failure.
 *
 * @param url - The Google endpoint URL (compile-time restricted to the known
 *   endpoints, so no caller-controlled URL can ever reach `fetch`).
 * @param body - The form parameters to POST.
 * @param logPrefix - Server-log prefix identifying the flow.
 * @param makeError - Builds the error thrown on any failure.
 * @returns The raw response text of the OK response.
 */
async function postGoogleForm(
	url: 'https://oauth2.googleapis.com/token' | 'https://oauth2.googleapis.com/revoke',
	body: URLSearchParams,
	logPrefix: string,
	makeError: () => Error
): Promise<string> {
	let res: Response;
	let text: string;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
			signal: AbortSignal.timeout(10_000)
		});
		text = await res.text();
	} catch (e) {
		console.error(`${logPrefix} request failed: ${e instanceof Error ? e.message : e}`);
		throw makeError();
	}
	if (!res.ok) {
		let detail = 'no error detail';
		try {
			const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown };
			if (typeof parsed?.error === 'string') {
				const description = typeof parsed.error_description === 'string' ? `: ${parsed.error_description}` : '';
				detail = `${parsed.error}${description}`;
			}
		} catch {
			// Non-JSON error body — status alone is enough.
		}
		console.error(`${logPrefix} failed: ${res.status} ${detail}`);
		throw makeError();
	}
	return text;
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

	const tokenText = await postGoogleForm(
		'https://oauth2.googleapis.com/token',
		new URLSearchParams({
			code,
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			redirect_uri: new URL(redirectPath, env.APP_URL).toString(),
			grant_type: 'authorization_code'
		}),
		logPrefix,
		() => error(502, userError)
	);
	let tokens: {
		access_token?: unknown;
		refresh_token?: unknown;
	};
	try {
		tokens = JSON.parse(tokenText) as typeof tokens;
	} catch {
		console.error(`${logPrefix} returned invalid JSON`);
		throw error(502, 'invalid response from Google — please retry');
	}
	if (typeof tokens !== 'object' || tokens === null) {
		console.error(`${logPrefix} returned a non-object body`);
		throw error(502, 'invalid response from Google — please retry');
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

/**
 * Revokes a token at Google's revocation endpoint (RFC 7009). Used on account
 * deletion so the user's YouTube grant dies with the account — a YouTube API
 * ToS requirement, not just hygiene.
 *
 * Throws on any failure (network or non-OK status): account deletion treats
 * each channel's revocation independently — the caller logs the failure
 * loudly and still deletes, since the encrypted token is erased either way.
 * The raw response body is logged server-side only; it never carries tokens.
 *
 * @param token - The refresh (or access) token to revoke.
 * @param logPrefix - Server-log prefix identifying the context (e.g. 'account deletion channel UC...').
 */
export async function revokeGoogleToken(token: string, logPrefix: string): Promise<void> {
	await postGoogleForm(
		'https://oauth2.googleapis.com/revoke',
		new URLSearchParams({ token }),
		`${logPrefix} revocation`,
		() => new Error('Google token revocation failed')
	);
}
