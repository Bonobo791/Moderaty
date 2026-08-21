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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

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
			// Stryker disable next-line OptionalChaining: equivalent — JSON.parse never yields undefined; when parsed is null the mutant's TypeError is swallowed by the same catch, leaving detail unchanged
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
