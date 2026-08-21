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

// SSR render tests for the account settings page (redesign Commit 5, spec §7
// Step 5.1/5.2): the identity header, the Connection ledger rows, and the
// DANGER ZONE delete flow moved off the dashboard. The delete button's three
// states are client-side, so the page accepts test-only seeds
// (initialConfirmed/initialArmed) that let SSR render each state directly.
//
// Gotchas: Svelte SSR inserts scoped-class hashes between class names, so
// class pins match a name inside the class attribute via regex; SSR emits
// component doc comments into the body, so pins target markup/visible copy,
// never words that might appear in comments; the render is lazy — assert on
// render(...).body.

import { render } from 'svelte/server';
import { expect, test } from 'vitest';

import Page from './+page.svelte';

const DATA = {
	user: { displayName: 'Ada Lovelace', email: 'ada@example.com' },
	channelCount: 2,
	maintenance: false,
	orgRole: 'owner'
};

const MAINTENANCE_DATA = { user: null, channelCount: 0, maintenance: true, orgRole: null };

function renderPage(overrides: Record<string, unknown> = {}) {
	return render(Page, {
		props: { data: DATA, form: null, ...overrides } as never
	}).body;
}

/** The delete submit button's opening tag, so attr pins can't leak to other elements. */
function deleteButtonTag(body: string): string {
	const match = body.match(/<button[^>]*\bdelete-btn\b[^>]*>/);
	expect(match, 'delete button tag present').not.toBeNull();
	return match![0];
}

test('a mid-load outage renders a maintenance state and hides the destructive delete control', () => {
	const body = render(Page, { props: { data: MAINTENANCE_DATA, form: null } as never }).body;
	expect(body).toContain('role="alert"');
	expect(body).toContain('Maintenance');
	expect(body).not.toContain('Delete my account');
	expect(body).not.toContain('name="confirm"');
});

test('the identity header renders the caps label, the name headline, and the mono sign-in line', () => {
	const body = renderPage();
	// Styled elements carry scoped-class hashes in SSR — pin via regex.
	expect(body).toMatch(/class="[^"]*\bcaps-label\b[^"]*"[^>]*>Account settings</);
	expect(body).toMatch(/<h1[^>]*>Ada Lovelace<\/h1>/);
	expect(body).toContain('Signed in with Google');
	expect(body).toMatch(/class="[^"]*\bmono\b[^"]*\bsigned-in\b[^"]*"/);
});

test('the connection ledger renders all four definition rows with their values', () => {
	const body = renderPage();
	for (const label of ['Account', 'Sign-in', 'Role', 'Access']) {
		expect(body).toMatch(new RegExp(`<dt[^>]*>${label}</dt>`));
	}
	expect(body).toMatch(/<dd[^>]*>ada@example.com<\/dd>/);
	expect(body).toMatch(/<dd[^>]*>Google<\/dd>/);
	expect(body).toMatch(/<dd[^>]*>Owner<\/dd>/);
	expect(body).toContain('2 YouTube channels connected');
});

test('the access row singularizes a single connected channel', () => {
	const body = renderPage({ data: { ...DATA, channelCount: 1 } });
	expect(body).toContain('1 YouTube channel connected');
});

test('sign out is a link-u button posting to /logout', () => {
	const body = renderPage();
	expect(body).toContain('action="/logout"');
	expect(body).toContain('method="POST"');
	expect(body).toMatch(/class="[^"]*\blink-u\b[^"]*\bsignout\b[^"]*"|class="[^"]*\bsignout\b[^"]*\blink-u\b[^"]*"/);
	expect(body).toContain('>Sign out</button>');
});

test('the danger zone renders the accent caps label, heading, and the verbatim legal copy', () => {
	const body = renderPage();
	expect(body).toMatch(/class="[^"]*\bdanger-zone\b[^"]*"/);
	expect(body).toMatch(/class="[^"]*\bdanger-label\b[^"]*"[^>]*>Danger zone</);
	expect(body).toMatch(/<h2[^>]*>Delete account<\/h2>/);
	// Distinctive spans of the legal paragraph moved byte-exact from the dashboard.
	expect(body).toContain('Deleting your account is immediate and permanent.');
	expect(body).toContain('blocked from any other use,');
	expect(body).toContain('href="https://security.google.com/settings/security/permissions"');
});

test('the delete form posts to the moved deleteAccount action with the confirm checkbox', () => {
	const body = renderPage();
	expect(body).toContain('action="?/deleteAccount"');
	expect(body).toContain('name="confirm"');
	expect(body).toContain('I understand and want to delete my Moderaty account');
});

test('state one — unchecked: the delete button is disabled with the plain label', () => {
	const body = renderPage();
	const tag = deleteButtonTag(body);
	expect(tag).toContain('disabled');
	expect(tag).not.toContain('outlined');
	expect(tag).not.toContain('armed');
	expect(body).toContain('Delete my account');
});

test('state two — checked: the delete button is enabled and outlined', () => {
	const body = renderPage({ initialConfirmed: true });
	const tag = deleteButtonTag(body);
	expect(tag).not.toContain('disabled');
	expect(tag).toMatch(/\boutlined\b/);
	expect(tag).not.toContain('armed');
	expect(body).toContain('Delete my account');
});

test('state three — armed: the button is solid-armed and carries the confirm warning label', () => {
	const body = renderPage({ initialConfirmed: true, initialArmed: true });
	const tag = deleteButtonTag(body);
	expect(tag).not.toContain('disabled');
	expect(tag).toMatch(/\barmed\b/);
	expect(body).toContain('>Click again to confirm. No restore window.</button>');
});
