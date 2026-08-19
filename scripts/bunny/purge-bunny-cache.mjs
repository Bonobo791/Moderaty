#!/usr/bin/env node
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
//
// OPTIONAL per-URL / full-zone Bunny purge CLI (docs/COOLIFY_BUNNY.md §3.5
// "Alternative purge trigger"). The repo default purges OUTSIDE the
// container via .github/workflows/bunny-purge.yml (scripts/bunny-purge.mjs,
// a zone-scoped key from repository secrets); this script is for operators
// who opt in to an in-container or manual purge instead.
//
// Purges the Bunny cache: full pull-zone purge by default, or per-URL purges
// when called with site paths / URLs as arguments.
//
// Manual full purge:
//   BUNNY_API_KEY=... BUNNY_PULL_ZONE_ID=<id> node scripts/bunny/purge-bunny-cache.mjs
// Manual page-level purge (no zone ID needed; paths resolve against SITE_URL):
//   BUNNY_API_KEY=... SITE_URL=https://moderaty.example \
//     node scripts/bunny/purge-bunny-cache.mjs /pricing/ /blog/
//
// Env:
//   BUNNY_API_KEY      Bunny account AccessKey (dashboard: Account -> API).
//                      Secret — never commit it or prefix it with PUBLIC_.
//   BUNNY_PULL_ZONE_ID Numeric ID of the site's pull zone (in the zone URL).
//                      Required only for the full-zone purge.
//   SITE_URL           Canonical site URL; resolves relative path arguments
//                      (defaults to APP_URL, the repo's existing convention).
//
// No-op (exit 0) when the required credentials are missing, so local builds/
// dev servers without Bunny credentials are unaffected. Invalid or
// un-normalizable URL arguments fail fast (exit 1) before any network call.
// Bunny APIs:
//   Full purge: POST https://api.bunny.net/pullzone/{id}/purgeCache  -> 204
//   URL purge:  POST https://api.bunny.net/purge?url=<url>            -> 204

import { normalizeSiteUrl } from './bunny-url.mjs';

const apiKey = process.env.BUNNY_API_KEY;
const pullZoneId = Number(process.env.BUNNY_PULL_ZONE_ID ?? '');
const siteUrl = process.env.SITE_URL ?? process.env.APP_URL ?? '';

if (!apiKey) {
	console.log('[bunny-purge] Skipped (BUNNY_API_KEY not set).');
	process.exit(0);
}

// Strips control characters (U+0000–U+001F and DEL) from a value before it is
// echoed to the terminal, so a crafted input cannot inject log lines or
// terminal escape sequences (S5145).
function printable(value) {
	let out = '';
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code >= 0x20 && code !== 0x7f) out += value[i];
	}
	return out;
}

async function purgeUrl(url) {
	const response = await fetch(`https://api.bunny.net/purge?url=${encodeURIComponent(url)}`, {
		method: 'POST',
		headers: { AccessKey: apiKey },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		console.error(`[bunny-purge] URL purge failed: HTTP ${response.status}`);
		return false;
	}
	return true;
}

const targets = process.argv.slice(2);
if (targets.length > 0) {
	if (!siteUrl) {
		console.error('[bunny-purge] SITE_URL (or APP_URL) is required to resolve path arguments.');
		process.exit(1);
	}
	const urls = [];
	for (const target of targets) {
		const url = normalizeSiteUrl(target, siteUrl);
		if (!url) {
			console.error(`[bunny-purge] Invalid target (must be a ${siteUrl} URL/path): ${printable(target)}`);
			process.exit(1);
		}
		urls.push(url);
	}
	// Sequential is deliberate: Bunny's URL-purge API is rate-limited per
	// account, and a network failure on one URL should not skip the rest of
	// the validated batch (the failed URL is recorded via the exit code).
	let ok = true;
	for (const url of urls) {
		console.log(`[bunny-purge] Purging ${url}`);
		try {
			if (!(await purgeUrl(url))) ok = false;
		} catch (error) {
			ok = false;
			console.error('[bunny-purge] URL purge failed:', error instanceof Error ? error.message : 'Unknown error');
		}
	}
	process.exit(ok ? 0 : 1);
}

// Full-zone purge (default, no arguments).
if (!Number.isInteger(pullZoneId) || pullZoneId <= 0) {
	console.log('[bunny-purge] Skipped (BUNNY_PULL_ZONE_ID not set).');
	process.exit(0);
}

try {
	const response = await fetch(`https://api.bunny.net/pullzone/${pullZoneId}/purgeCache`, {
		method: 'POST',
		headers: { AccessKey: apiKey },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		// S5145: the Bunny API response body is external data and is never
		// interpolated into log output — a forged body could inject log lines
		// or terminal escape sequences (Sonar does not treat a
		// strip-control-characters pass as sanitization). The status code
		// alone identifies the failure class; reproduce the call with curl
		// for the full API error body.
		console.error(`[bunny-purge] Failed: HTTP ${response.status}`);
		process.exit(1);
	}
	console.log(`[bunny-purge] Pull zone ${pullZoneId} cache purged.`);
} catch (error) {
	console.error('[bunny-purge] Failed:', error instanceof Error ? error.message : 'Unknown error');
	process.exit(1);
}
