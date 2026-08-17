#!/usr/bin/env node
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
//
// Bunny CDN cache purge (docs/COOLIFY_BUNNY.md). Bunny never auto-detects
// origin changes, so every Coolify deploy must purge the pull zone after the
// new container is healthy — Coolify's "Post Deployment Command" runs this
// script in the fresh container after each successful deployment.
//
// Purges the WHOLE site: POST https://api.bunny.net/purge?url=<site>/*&async=true
// with the account API key in an AccessKey header. The wildcard URL pattern
// is built from BUNNY_PURGE_URL, or APP_URL when BUNNY_PURGE_URL is unset
// (APP_URL is the public origin — behind Bunny that is the CDN domain, which
// is exactly the zone whose cache must go). A purge that failed must never
// look like one that succeeded: any missing credential or non-OK answer
// throws, and the CLI exits non-zero so Coolify surfaces the failure loudly.
//
// Note the Bunny rate limit: sustained wildcard purges are ~30/minute — one
// purge per deploy is far below it.

const PURGE_TIMEOUT_MS = 30_000;

/**
 * Purges the entire site cache through Bunny CDN.
 *
 * @returns {Promise<object>} The Bunny purge API JSON payload.
 * @throws {Error} If required configuration is missing or the API responds with a non-OK status.
 */
export async function purgeSite(fetchImpl = fetch) {
	const accessKey = process.env.BUNNY_ACCESS_KEY;
	if (!accessKey) {
		throw new Error('BUNNY_ACCESS_KEY is not set — the Bunny CDN cache cannot be purged');
	}
	const base = process.env.BUNNY_PURGE_URL ?? process.env.APP_URL;
	if (!base) {
		throw new Error('BUNNY_PURGE_URL (or APP_URL) is not set — no site URL to purge');
	}
	const pattern = new URL('/*', base).toString();
	const res = await fetchImpl(`https://api.bunny.net/purge?url=${encodeURIComponent(pattern)}&async=true`, {
		method: 'POST',
		headers: { AccessKey: accessKey },
		signal: AbortSignal.timeout(PURGE_TIMEOUT_MS)
	});
	if (!res.ok) {
		throw new Error(`Bunny purge answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	const payload = await res.json();
	// Strip CR/LF before logging: the payload is remote content and a raw
	// newline in it would let a response forge extra log lines (S5145).
	console.log(`[${new Date().toISOString()}] bunny purge → ${JSON.stringify(payload).replaceAll(/[\r\n]+/g, ' ')}`);
	return payload;
}

// Only run the purge when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		await purgeSite();
	} catch (cause) {
		console.error('bunny purge failed:', cause);
		process.exit(1);
	}
}
