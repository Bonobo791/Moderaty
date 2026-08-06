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

// SSR render tests for the dashboard page: the load can report a mid-load
// outage (maintenance: true) AFTER the layout decided it is healthy, so the
// page must render its own maintenance state instead of destructive controls
// (PR #123 review — codeant). Also pins the role gate on the disconnect
// danger block.

import { render } from 'svelte/server';
import { expect, test } from 'vitest';

import Page from './+page.svelte';

const MAINTENANCE_DATA = { chs: [], stats: [], bans: [], maintenance: true, orgRole: null };

const NORMAL_DATA = {
	chs: [
		{
			id: 'UC1',
			title: 'My Channel',
			cursor: null,
			lastRunAt: null,
			toneLevel: 1,
			protectLgbtqia: 0,
			protectWomen: 0
		}
	],
	stats: [],
	bans: [],
	maintenance: false,
	orgRole: 'owner'
};

function renderPage(data: unknown) {
	return render(Page, { props: { data, form: null } as never }).body;
}

test('a mid-load outage renders a maintenance state and hides every destructive control', () => {
	const body = renderPage(MAINTENANCE_DATA);
	expect(body).toContain('role="alert"');
	expect(body).not.toContain('Delete my account');
	expect(body).not.toContain('Disconnect channel');
	expect(body).not.toContain('Connect YouTube channel');
});

test('normal render shows the disconnect danger block to an owner', () => {
	const body = renderPage(NORMAL_DATA);
	expect(body).toContain('Disconnect channel My Channel');
	expect(body).toContain('Delete my account');
});

test('normal render hides the disconnect danger block from a member (the action enforces regardless)', () => {
	const body = renderPage({ ...NORMAL_DATA, orgRole: 'member' });
	expect(body).not.toContain('Disconnect channel');
	expect(body).toContain('Delete my account');
});

// The dry-run backend has always accepted `months` (default 3); the select was
// the deferred #119 frontend follow-up. A 3-month-only button reads as "0
// scanned" on any channel whose comments are older than the window.
test('the dry-run form offers the window presets with a labeled select, defaulting to 3 months', () => {
	const body = renderPage(NORMAL_DATA);
	expect(body).toContain('id="dryrun-months-UC1"');
	expect(body).toContain('name="months"');
	expect(body).toContain('aria-label="How far back the dry run covers on My Channel"');
	expect(body).toContain('>last 24 months</option>');
	// "All time" covers channels whose comments predate every months preset.
	expect(body).toContain('value="all"');
	expect(body).toContain('>all time</option>');
});

test('an all-time dry-run result names the window in the success line', () => {
	const body = render(Page, {
		props: {
			data: NORMAL_DATA,
			form: { ok: true, scope: 'dryRun', channelId: 'UC1', months: 'all', fetched: 6, acted: 0, queued: 0, partial: false }
		} as never
	}).body;
	expect(body).toContain('Dry run preview (all time): 6 comments scanned');
});

// The "History scan started" action message dies with the form result on
// refresh, but the drain keeps running server-side — a mid-drain channel
// must show a persistent in-progress status instead.
test('a mid-drain channel shows a persistent scan-in-progress status', () => {
	const body = renderPage({ ...NORMAL_DATA, chs: [{ ...NORMAL_DATA.chs[0], scanning: true }] });
	expect(body).toContain('History scan in progress');
	expect(body).toContain('in the background');
});

test('an idle channel does not show the scan-in-progress status', () => {
	const body = renderPage(NORMAL_DATA);
	expect(body).not.toContain('History scan in progress');
});
