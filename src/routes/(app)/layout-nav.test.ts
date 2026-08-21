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

// SSR pins for the app header (redesign Commit 5): the displayName links to
// /account, and the nav link matching the current pathname gets the active
// class (2px --accent underline) + aria-current="page". The layout reads
// page.url from $app/state, which standalone SSR cannot provide, so the mock
// below hands each test a mutable URL.
//
// Gotchas: scoped-class hashes sit between class names — pin via regex on the
// class attribute; the render is lazy — assert on render(...).body.

import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';

const mockPage = vi.hoisted(() => ({ url: new URL('http://localhost/dashboard') }));
vi.mock('$app/state', () => ({ page: mockPage }));

import { TEST_OWNER } from '$lib/server/testdb';

import Layout from './+layout.svelte';

const children = createRawSnippet(() => ({ render: () => '<p>CHILD_PAGE_CONTENT</p>' }));

function renderShell(pathname: string) {
	mockPage.url = new URL(`http://localhost${pathname}`);
	return render(Layout, {
		props: {
			data: { user: { ...TEST_OWNER, displayName: 'Ada Lovelace' }, orgs: [], maintenance: false },
			children
		} as never
	}).body;
}

/** The nav anchor for one href + label, cut out so pins can't leak to other links. */
function navLink(body: string, href: string, text: string): string {
	const match = body.match(new RegExp(`<a[^>]*href="${href}"[^>]*>${text}</a>`));
	expect(match, `nav link ${href} present`).not.toBeNull();
	return match![0];
}

test('the displayName is a link to /account', () => {
	const body = renderShell('/dashboard');
	expect(navLink(body, '/account', 'Ada Lovelace')).toMatch(/\baccount-link\b/);
});

test('the link for the current page gets the active class and aria-current="page"', () => {
	const body = renderShell('/dashboard');
	const active = navLink(body, '/dashboard', 'Dashboard');
	expect(active).toMatch(/\bactive\b/);
	expect(active).toContain('aria-current="page"');
	// …while the other nav links stay inactive.
	for (const [href, text] of [['/org', 'Team'], ['/help', 'Help'], ['/account', 'Ada Lovelace']]) {
		expect(navLink(body, href, text)).not.toContain('active');
		expect(navLink(body, href, text)).not.toContain('aria-current');
	}
});

test('the account link is the active one on /account', () => {
	const body = renderShell('/account');
	const active = navLink(body, '/account', 'Ada Lovelace');
	expect(active).toMatch(/\bactive\b/);
	expect(active).toContain('aria-current="page"');
	for (const [href, text] of [['/dashboard', 'Dashboard'], ['/org', 'Team'], ['/help', 'Help']]) {
		expect(navLink(body, href, text)).not.toContain('active');
	}
});

test('the Usage link stays active on nested usage routes (e.g. /usage/success)', () => {
	// /usage/success is a child of /usage; the checkout redirect lands there,
	// and the nav must not silently drop the active state (coderabbit).
	const body = renderShell('/usage/success');
	const usage = navLink(body, '/usage', 'Usage');
	expect(usage).toContain('active');
	expect(usage).toContain('aria-current="page"');
	expect(navLink(body, '/dashboard', 'Dashboard')).not.toContain('active');
});

test('Team and Help light up on their own routes', () => {
	expect(navLink(renderShell('/org'), '/org', 'Team')).toContain('active');
	expect(navLink(renderShell('/help'), '/help', 'Help')).toContain('active');
});

test('the brand wordmark never carries the active state', () => {
	const body = renderShell('/dashboard');
	const brand = body.match(/<a[^>]*\bbrand\b[^>]*>/)![0];
	expect(brand).not.toContain('active');
	expect(brand).not.toContain('aria-current');
});

// Route transition (redesign Commit 6): page content renders inside the
// pathname-keyed wrapper that runs the 200ms fade/rise on navigation.
test('page content renders inside the route-transition wrapper', () => {
	const body = renderShell('/dashboard');
	expect(body).toMatch(/<main class="app-main route-enter[^"]*">/);
	expect(body).toContain('CHILD_PAGE_CONTENT');
});
