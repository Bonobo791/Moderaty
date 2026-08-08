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

// SSR render tests for the channel detail shell (layout header + tab bar)
// and the overview page (the controls moved from the dashboard cards).
// Svelte's SSR render is lazy: assert on render(...).body.

import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { expect, test } from 'vitest';

import Layout from './+layout.svelte';
import Page from './+page.svelte';

const children = createRawSnippet(() => ({ render: () => '<p>CHILD_PAGE_CONTENT</p>' }));

const LAYOUT_DATA = {
	ch: {
		id: 'UC1',
		title: 'My Channel',
		lastRunAt: null,
		toneLevel: 1,
		protectLgbtqia: 1,
		protectWomen: 0,
		scanning: false
	},
	pending: 0,
	banned: 7,
	tab: 'overview',
	maintenance: false,
	orgRole: 'owner'
};

function renderLayout(data: unknown) {
	return render(Layout, { props: { data, children } as never }).body;
}

function renderPage(data: unknown, form: unknown = null) {
	return render(Page, { props: { data, form } as never }).body;
}

// ── layout: channel header ─────────────────────────────────────────────

test('the header links back to the dashboard and names the channel with a mono ID subline', () => {
	const body = renderLayout(LAYOUT_DATA);
	expect(body).toContain('href="/dashboard"');
	expect(body).toContain('Back to channels');
	expect(body).toContain('<h1');
	expect(body).toContain('My Channel');
	expect(body).toContain('ID: UC1 · Last checked never');
});

test('the header subline renders a relative last-checked time when the channel has run', () => {
	const body = renderLayout({
		...LAYOUT_DATA,
		ch: { ...LAYOUT_DATA.ch, lastRunAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }
	});
	expect(body).toContain('ID: UC1 · Last checked 2 hours ago');
});

test('the header shows PROTECTED, the clear-queue subline, and the banned ticker', () => {
	const body = renderLayout(LAYOUT_DATA);
	expect(body).toContain('Protected');
	expect(body).toContain('queue is clear');
	// Ticker SSR renders the target directly.
	expect(body).toContain('mono">7</span>');
	expect(body).toContain('Edge lords banned');
});

test('a non-zero pending count links to the queue from the header status', () => {
	const body = renderLayout({ ...LAYOUT_DATA, pending: 2 });
	expect(body).toContain('href="/channels/UC1/queue"');
	expect(body).toContain('2 comments waiting for review');
	expect(body).not.toContain('queue is clear');
});

// ── layout: tab bar ────────────────────────────────────────────────────

test('the tab bar is a tablist with all four section links and the queue count in the label', () => {
	const body = renderLayout({ ...LAYOUT_DATA, pending: 3 });
	expect(body).toContain('role="tablist"');
	expect(body).toContain('href="/channels/UC1"');
	expect(body).toContain('href="/channels/UC1/rules"');
	expect(body).toContain('href="/channels/UC1/queue"');
	expect(body).toContain('href="/channels/UC1/log"');
	expect(body).toContain('Review queue (3)');
	expect(body).toContain('Overview');
	expect(body).toContain('Rules');
	expect(body).toContain('Audit log');
});

test.each([
	{ tab: 'overview', href: '/channels/UC1"', selected: 'aria-selected="true"' },
	{ tab: 'rules', href: '/channels/UC1/rules', selected: 'aria-selected="true"' },
	{ tab: 'queue', href: '/channels/UC1/queue', selected: 'aria-selected="true"' },
	{ tab: 'log', href: '/channels/UC1/log', selected: 'aria-selected="true"' }
])('the "$tab" tab is aria-selected when active', ({ tab, href }) => {
	const body = renderLayout({ ...LAYOUT_DATA, tab });
	// The active tab carries aria-selected="true"; exactly one tab does.
	expect(body.match(/aria-selected="true"/g)).toHaveLength(1);
	expect(body).toContain(`href="${href}`);
	// Inactive tabs are explicitly unselected (tablist semantics).
	expect(body.match(/aria-selected="false"/g)).toHaveLength(3);
});

test('the layout renders its child page', () => {
	const body = renderLayout(LAYOUT_DATA);
	expect(body).toContain('CHILD_PAGE_CONTENT');
});

test('a mid-load outage renders a maintenance state instead of the header and tabs', () => {
	const body = renderLayout({
		ch: { id: 'UC1', title: '', lastRunAt: null, toneLevel: null, protectLgbtqia: 0, protectWomen: 0, scanning: false },
		pending: 0,
		banned: 0,
		tab: 'overview',
		maintenance: true,
		orgRole: null
	});
	expect(body).toContain('role="alert"');
	expect(body).toContain('Maintenance');
	expect(body).not.toContain('role="tablist"');
	expect(body).not.toContain('CHILD_PAGE_CONTENT');
});

// ── overview page: moved channel controls ─────────────────────────────

test('the sensitivity control renders the labeled slider and both meme endpoints', () => {
	const body = renderPage(LAYOUT_DATA);
	expect(body).toContain('type="range"');
	expect(body).toContain('aria-label="Moderation sensitivity for My Channel"');
	expect(body).toContain('name="toneLevel"');
	expect(body).toContain('src="/edge-lord.jpg"');
	expect(body).toContain('src="/ackchyually.gif"');
	expect(body).toContain('EDGE LORD');
	expect(body).toContain('EDGE LORD + ACKCHYUALLY');
	expect(body).toContain('Only hateful and abusive comments are moderated.');
});

test('the sensitivity description switches copy at the strict level', () => {
	const body = renderPage({ ...LAYOUT_DATA, ch: { ...LAYOUT_DATA.ch, toneLevel: 2 } });
	expect(body).toContain('Hateful comments and demeaning, condescending, or sarcastic tone are moderated.');
});

test('strict protection renders both labeled checkboxes with their persisted state', () => {
	const body = renderPage(LAYOUT_DATA);
	expect(body).toContain('Strict protection');
	expect(body).toContain('Harassment targeting LGBTQIA+ people');
	expect(body).toContain('Harassment targeting women');
	expect(body).toContain('for="protect-lgbtqia-UC1"');
	expect(body).toContain('for="protect-women-UC1"');
	expect(body).toContain('Heightened AI scrutiny for these comments, at any sensitivity level.');
});

test('the analyze-history form offers the window presets with a labeled select', () => {
	const body = renderPage(LAYOUT_DATA);
	expect(body).toContain('for="history-months-UC1"');
	expect(body).toContain('aria-label="How far back to analyze comments on My Channel"');
	expect(body).toContain('>last 24 months</option>');
	expect(body).toContain('Analyze history on My Channel');
});

test('the dry-run form offers the window presets with a labeled select, defaulting to 3 months', () => {
	const body = renderPage(LAYOUT_DATA);
	expect(body).toContain('id="dryrun-months-UC1"');
	expect(body).toContain('name="months"');
	expect(body).toContain('aria-label="How far back the dry run covers on My Channel"');
	expect(body).toContain('>last 24 months</option>');
	// "All time" covers channels whose comments predate every months preset.
	expect(body).toContain('value="all"');
	expect(body).toContain('>all time</option>');
	expect(body).toContain('aria-label="Run a dry-run preview on My Channel"');
});

test('an all-time dry-run result names the window in the success line', () => {
	const body = renderPage(LAYOUT_DATA, {
		ok: true,
		scope: 'dryRun',
		channelId: 'UC1',
		months: 'all',
		fetched: 6,
		acted: 0,
		queued: 0,
		partial: false
	});
	expect(body).toContain('Dry run preview (all time): 6 comments scanned');
});

test('a dry-run failure renders the scoped error', () => {
	const body = renderPage(LAYOUT_DATA, {
		scope: 'dryRun',
		channelId: 'UC1',
		error: 'The dry run failed — check the server log and try again.'
	});
	expect(body).toContain('role="alert"');
	expect(body).toContain('The dry run failed — check the server log and try again.');
});

// The "History scan started" action message dies with the form result on
// refresh, but the drain keeps running server-side — a mid-drain channel
// must show a persistent in-progress status instead.
test('a mid-drain channel shows a persistent scan-in-progress status', () => {
	const body = renderPage({ ...LAYOUT_DATA, ch: { ...LAYOUT_DATA.ch, scanning: true } });
	expect(body).toContain('History scan in progress');
	expect(body).toContain('in the background');
});

test('an idle channel does not show the scan-in-progress status', () => {
	const body = renderPage(LAYOUT_DATA);
	expect(body).not.toContain('History scan in progress');
});

test('the disconnect danger block renders for an owner with the confirm checkbox labeled', () => {
	const body = renderPage(LAYOUT_DATA);
	expect(body).toContain('Danger zone — disconnect channel');
	expect(body).toContain('Disconnect channel My Channel');
	expect(body).toContain('for="confirm-disconnect-UC1"');
	expect(body).toContain('I understand — disconnect My Channel and erase its data');
});

test('the disconnect danger block renders for an admin', () => {
	const body = renderPage({ ...LAYOUT_DATA, orgRole: 'admin' });
	expect(body).toContain('Disconnect channel My Channel');
});

test('the disconnect danger block is hidden from a member (the action enforces regardless)', () => {
	const body = renderPage({ ...LAYOUT_DATA, orgRole: 'member' });
	expect(body).not.toContain('Disconnect channel');
});

test('every control form posts the channel id the moved actions still require', () => {
	const body = renderPage(LAYOUT_DATA);
	// Sensitivity, protections, history, dry run, disconnect: five hidden fields.
	expect(body.match(/name="channelId" value="UC1"/g)).toHaveLength(5);
});
