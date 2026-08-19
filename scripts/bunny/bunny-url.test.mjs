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
// Unit tests for the shared Bunny purge URL normalizer
// (scripts/bunny/bunny-url.mjs). Every rejection below must return null —
// if any of them starts returning a URL, a crafted path could purge a
// foreign host or the whole zone (prefix purge), so the test failing loudly
// is the point.

import { describe, expect, it } from 'vitest';
import { normalizeSiteUrl } from './bunny-url.mjs';

const BASE = 'https://moderaty.example';

describe('normalizeSiteUrl — accepted inputs', () => {
	it('normalizes a site-relative path', () => {
		expect(normalizeSiteUrl('/pricing/', BASE)).toBe('https://moderaty.example/pricing/');
		expect(normalizeSiteUrl('/blog', BASE)).toBe('https://moderaty.example/blog');
	});

	it('trims surrounding whitespace before validating', () => {
		expect(normalizeSiteUrl('  /pricing/  ', BASE)).toBe('https://moderaty.example/pricing/');
	});

	it('accepts an absolute URL on the site’s own host', () => {
		expect(normalizeSiteUrl('https://moderaty.example/pricing/', BASE)).toBe('https://moderaty.example/pricing/');
	});

	it('strips the fragment (the edge never caches by fragment)', () => {
		expect(normalizeSiteUrl('/pricing?x=1#section', BASE)).toBe('https://moderaty.example/pricing?x=1');
	});

	it('keeps percent-encoded path characters intact', () => {
		expect(normalizeSiteUrl('/foo%20bar', BASE)).toBe('https://moderaty.example/foo%20bar');
	});

	it('keeps the trailing slash that makes Bunny treat a purge as prefix purge', () => {
		expect(normalizeSiteUrl('/pricing/', BASE)).toMatch(/\/$/);
	});

	it('accepts the bare origin', () => {
		expect(normalizeSiteUrl('https://moderaty.example', BASE)).toBe('https://moderaty.example/');
	});
});

describe('normalizeSiteUrl — rejected inputs (must be null)', () => {
	it('rejects empty, null, and undefined input', () => {
		expect(normalizeSiteUrl('', BASE)).toBeNull();
		expect(normalizeSiteUrl(null, BASE)).toBeNull();
		expect(normalizeSiteUrl(undefined, BASE)).toBeNull();
	});

	it('rejects a URL on a foreign host', () => {
		expect(normalizeSiteUrl('https://evil.example/pricing', BASE)).toBeNull();
	});

	it('rejects a different scheme', () => {
		expect(normalizeSiteUrl('http://moderaty.example/pricing', BASE)).toBeNull();
	});

	it('rejects a different port', () => {
		expect(normalizeSiteUrl('https://moderaty.example:8443/pricing', BASE)).toBeNull();
	});

	it('rejects a userinfo trick that lands on a foreign host', () => {
		expect(normalizeSiteUrl('https://moderaty.example@evil.example/pricing', BASE)).toBeNull();
	});

	it('rejects a lookalike hostname', () => {
		expect(normalizeSiteUrl('https://moderaty.example.evil.example/pricing', BASE)).toBeNull();
	});

	it('rejects wildcards, raw and percent-encoded', () => {
		expect(normalizeSiteUrl('/pricing/*', BASE)).toBeNull();
		expect(normalizeSiteUrl('/pricing/%2A', BASE)).toBeNull();
	});

	it('rejects dot segments, raw and percent-encoded', () => {
		expect(normalizeSiteUrl('/../pricing', BASE)).toBeNull();
		expect(normalizeSiteUrl('/foo/../../bar', BASE)).toBeNull();
		expect(normalizeSiteUrl('/%2e%2e/pricing', BASE)).toBeNull();
		expect(normalizeSiteUrl('/foo%2f..%2fbar', BASE)).toBeNull();
	});

	it('rejects backslashes (WHATWG treats them as path separators)', () => {
		expect(normalizeSiteUrl('/foo\\..\\', BASE)).toBeNull();
	});

	it('rejects control characters', () => {
		expect(normalizeSiteUrl('/pricing\u0001x', BASE)).toBeNull();
		expect(normalizeSiteUrl('/pricing\u007fx', BASE)).toBeNull();
	});

	it('rejects relative paths that do not start with a single slash', () => {
		expect(normalizeSiteUrl('pricing', BASE)).toBeNull();
		expect(normalizeSiteUrl('//pricing', BASE)).toBeNull();
	});

	it('rejects input longer than 1024 characters', () => {
		expect(normalizeSiteUrl('/' + 'a'.repeat(1100), BASE)).toBeNull();
	});

	it('rejects input that is not valid UTF-8 when decoded', () => {
		expect(normalizeSiteUrl('/%FF', BASE)).toBeNull();
	});

	it('returns null when the base URL is invalid', () => {
		expect(normalizeSiteUrl('/pricing', 'not-a-url')).toBeNull();
	});
});
