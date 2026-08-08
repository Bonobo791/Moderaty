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
// (PR #123 review — codeant). The per-channel controls (sensitivity,
// protections, history, dry run, disconnect) moved to the channel detail
// page — their pins live in channels/[id]/channel-page.test.ts.

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
			protectWomen: 0,
			scanning: false
		}
	],
	stats: [{ channelId: 'UC1', status: 'pending', n: 2 }],
	bans: [{ channelId: 'UC1', n: 3 }],
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
	expect(body).not.toContain('Connect YouTube channel');
});

test('normal render shows the delete-account card', () => {
	const body = renderPage(NORMAL_DATA);
	expect(body).toContain('Delete my account');
});

test('each channel card links to its detail page and section tabs', () => {
	const body = renderPage(NORMAL_DATA);
	expect(body).toContain('href="/channels/UC1"');
	expect(body).toContain('href="/channels/UC1/rules"');
	expect(body).toContain('href="/channels/UC1/queue"');
	expect(body).toContain('href="/channels/UC1/log"');
});

test('each channel card shows the status line, stat badges, and the ban count', () => {
	const body = renderPage(NORMAL_DATA);
	expect(body).toContain('2 comments waiting for review');
	expect(body).toContain('pending: 2');
	expect(body).toContain('3 Edge Lords Banned');
});

test('the channel controls moved to the detail page — the dashboard renders none of them', () => {
	const body = renderPage(NORMAL_DATA);
	expect(body).not.toContain('type="range"');
	expect(body).not.toContain('Analyze history');
	expect(body).not.toContain('Dry run');
	expect(body).not.toContain('Disconnect channel');
	expect(body).not.toContain('Strict protection');
});
