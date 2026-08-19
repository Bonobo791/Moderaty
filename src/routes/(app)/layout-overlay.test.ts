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

import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';

// The layout reads page.url for the nav active state; standalone SSR has no
// request context, so $app/state is mocked (see layout-nav.test.ts for the
// active-state pins).
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/dashboard') } }));

import { TEST_OWNER } from '$lib/server/testdb';

import Layout from './+layout.svelte';

const OUTAGE_COPY = 'temporarily unable to reach its database';

const children = createRawSnippet(() => ({ render: () => '<p>CHILD_PAGE_CONTENT</p>' }));

function renderShell(data: { user: unknown; orgs: unknown[]; maintenance: boolean }) {
	// `as never` on props: the generated LayoutData type does not model the
	// outage payload (user: null), which is exactly what these tests exercise.
	return render(Layout, { props: { data, children } as never }).body;
}

test('maintenance replaces the page content with an overlay and hides account affordances', () => {
	const html = renderShell({ user: null, orgs: [], maintenance: true });
	expect(html).toContain(OUTAGE_COPY);
	expect(html).toContain('role="alert"');
	expect(html).not.toContain('CHILD_PAGE_CONTENT');
	expect(html).not.toContain('Sign out');
	expect(html).not.toContain('team-select');
});

test('maintenance with a verified session still hides sign-out — its write cannot succeed', () => {
	const html = renderShell({ user: TEST_OWNER, orgs: [], maintenance: true });
	expect(html).toContain(OUTAGE_COPY);
	expect(html).not.toContain('Sign out');
	expect(html).not.toContain('CHILD_PAGE_CONTENT');
});

test('normal operation renders the page content and the account menu', () => {
	const html = renderShell({
		user: { ...TEST_OWNER, displayName: 'Ada Lovelace' },
		orgs: [],
		maintenance: false
	});
	expect(html).toContain('CHILD_PAGE_CONTENT');
	expect(html).toContain('Sign out');
	expect(html).toContain('Ada Lovelace');
	expect(html).not.toContain(OUTAGE_COPY);
});
