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

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('app shell', () => {
	test('app.html declares a default <title> so every page has a document title', () => {
		// sonarcloud Web:PageWithoutTitleCheck (MAJOR, reliability): the shell
		// shipped without a <title>, so pages that do not set one via
		// <svelte:head> render with no document title. Pages override this
		// default with their own <svelte:head><title>.
		const html = readFileSync(new URL('./app.html', import.meta.url), 'utf8');
		expect(html).toMatch(/<title[^>]*>[^<]+<\/title>/);
		expect(html).toMatch(/<title[^>]*>Moderaty<\/title>/);

		// The fallback must come AFTER %sveltekit.head%: a page's own
		// <svelte:head><title> is injected at that placeholder, and the browser
		// uses the FIRST <title> in the document — a fallback placed before the
		// placeholder would shadow every route-specific title.
		const fallbackTitle = html.indexOf('<title>Moderaty</title>');
		const svelteKitHead = html.indexOf('%sveltekit.head%');
		expect(svelteKitHead).toBeGreaterThanOrEqual(0); // placeholder must exist (indexOf -1 would silently pass the comparison)
		expect(fallbackTitle).toBeGreaterThan(svelteKitHead);
	});
});
