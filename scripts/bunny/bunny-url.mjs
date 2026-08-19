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
// Shared Bunny cache-purge URL normalization.
//
// Single copy of the site-URL validation used by the purge CLI:
//   - scripts/bunny/purge-bunny-cache.mjs (imports this file directly; the
//     Docker runtime image ships scripts/bunny/)
//
// Keep this file dependency-free plain JS — it must run on the runtime
// image's bare Node without any build step.

const SCHEME_RE = /^https?:\/\//i;
const PATH_SPLIT_RE = /[?#]/;
const SCHEME_STRIP_RE = /^https?:\/\/[^/]*/i;
// RFC 3986 dot segments (raw or percent-encoded) in the path mean malformed
// input — reject them before the URL parser can silently normalize them away.
const DOT_SEGMENT_RE = /(^|\/)(\.|\.\.|%2e|\.%2e|%2e\.|%2e%2e)(\/|$)/i;
const DECODED_DOT_SEGMENT_RE = /(^|\/)(\.|\.\.)(\/|$)/;

// Rejects control characters (U+0000–U+001F and DEL) without a regex
// containing raw control-character escapes.
function hasControlChars(value) {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Normalizes a site-relative path or an absolute URL on the site's own host
 * into an absolute URL safe to hand to Bunny's URL-purge API. Returns null
 * when the input is not a purgeable site URL.
 *
 * Rejected: URLs with a different scheme, host, or port than the base URL (a
 * userinfo or port trick lands on a foreign hostname/port, so it is caught
 * by the same comparison), wildcards (a trailing slash already makes Bunny
 * treat the purge as a prefix purge — no caller needs `*`), path-traversal
 * segments (raw and percent-encoded), backslashes, and control characters.
 * Fragments are accepted and stripped (the edge never caches by fragment).
 */
export function normalizeSiteUrl(input, baseUrl) {
	const value = String(input ?? '').trim();
	if (!value || value.length > 1024) return null;
	if (hasControlChars(value)) return null;
	// Backslashes are treated as '/' by WHATWG URL parsing in http(s) paths,
	// which would let '/foo\..\' slip past the dot-segment check below and
	// normalize to the zone root (a prefix purge of everything). No site URL
	// contains one — reject outright.
	if (value.includes('\\')) return null;

	const rawPath = value.split(PATH_SPLIT_RE, 1)[0].replace(SCHEME_STRIP_RE, '');
	if (DOT_SEGMENT_RE.test(rawPath)) return null;

	let site;
	try {
		site = new URL(baseUrl);
	} catch {
		return null;
	}

	let candidate;
	if (SCHEME_RE.test(value)) {
		try {
			candidate = new URL(value);
		} catch {
			return null;
		}
		if (candidate.protocol !== site.protocol || candidate.hostname.toLowerCase() !== site.hostname.toLowerCase() || candidate.port !== site.port) return null;
	} else {
		if (!value.startsWith('/') || value.startsWith('//')) return null;
		try {
			candidate = new URL(value, site.origin);
		} catch {
			return null;
		}
	}

	candidate.hash = '';

	// Check both the raw and the percent-decoded path so encodings cannot
	// smuggle a traversal segment or a wildcard past the checks. A URL whose
	// decoded form is not valid UTF-8 can't be a site URL we serve anyway.
	let decoded;
	try {
		decoded = decodeURIComponent(candidate.pathname);
	} catch {
		return null;
	}
	// Encoded slashes keep dot segments out of reach of the raw check above
	// (e.g. '/foo%2f..%2fbar'), so re-test the decoded path for them too.
	if (decoded.includes('*') || candidate.pathname.includes('*')) {
		return null;
	}
	if (DECODED_DOT_SEGMENT_RE.test(decoded)) {
		return null;
	}

	return candidate.toString();
}
