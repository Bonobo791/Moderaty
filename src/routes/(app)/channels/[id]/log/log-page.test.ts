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

// SSR render pins for the audit-log pagination nav: the links are the only
// way past page 1, so their presence/absence and href shape are the contract.

import { render } from 'svelte/server';
import { expect, test } from 'vitest';

import Page from './+page.svelte';

const ENTRY = {
	id: 7,
	channelId: 'UC1',
	commentId: 'c-1',
	action: 'approve',
	reason: 'test',
	actor: 'system',
	text: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	undoable: null
};

function renderLog(overrides: Record<string, unknown> = {}) {
	return render(Page, {
		props: {
			data: {
				ch: { id: 'UC1', title: 'Ch' },
				entries: [ENTRY],
				nextCursor: null,
				hasPrev: false,
				...overrides
			},
			form: null
		} as never
	}).body;
}

test('a single page of entries renders no pagination nav', () => {
	const body = renderLog();
	expect(body).not.toContain('<nav class="pager"');
	expect(body).not.toContain('Older');
	expect(body).not.toContain('Newest');
});

test('a continuation cursor renders an Older link whose href carries the encoded cursor', () => {
	const body = renderLog({ nextCursor: '2026-01-01T00:00:00.000Z|7' });
	expect(body).toContain('href="/channels/UC1/log?before=2026-01-01T00%3A00%3A00.000Z%7C7"');
	// Still on page 1 — no way "back" to newest.
	expect(body).not.toContain('href="/channels/UC1/log"');
});

test('a deep page renders a Newest link whose href is exactly the bare log URL', () => {
	const body = renderLog({ hasPrev: true, nextCursor: '2026-01-01T00:00:00.000Z|7' });
	expect(body).toContain('href="/channels/UC1/log"');
	expect(body).toContain('href="/channels/UC1/log?before=2026-01-01T00%3A00%3A00.000Z%7C7"');
});
