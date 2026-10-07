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
	authorHandle: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	undoable: null
};

function renderLog(overrides: Record<string, unknown> = {}) {
	return render(Page, {
		props: {
			data: {
				ch: { id: 'UC1', title: 'Ch' },
				entries: [ENTRY],
				recovery: [],
				dispatches: [],
				canRecover: true,
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

test('the table head has a Handle column between Comment and Reason', () => {
	const body = renderLog();
	expect(body).toContain('<th>Handle</th>');
	expect(body.indexOf('<th>Comment</th>')).toBeLessThan(body.indexOf('<th>Handle</th>'));
	expect(body.indexOf('<th>Handle</th>')).toBeLessThan(body.indexOf('<th>Reason</th>'));
});

test('a row with an author handle renders it in the Handle cell', () => {
	const body = renderLog({ entries: [{ ...ENTRY, authorHandle: 'some.user' }] });
	expect(body).toContain('data-label="Handle"');
	expect(body).toContain('some.user');
});

test('a row without an author handle renders the em-dash fallback', () => {
	// Manual/pre-migration rows carry no handle — the cell shows '—', not blank.
	const body = renderLog({ entries: [{ ...ENTRY, authorHandle: null }] });
	expect(body).toContain('data-label="Handle">—</td>');
});

test('the danger zone renders the erase-handles explanation and a labeled button', () => {
	const body = renderLog();
	expect(body).toContain('kept for 30 days, then erased automatically');
	expect(body).toContain('action="?/eraseHandles"');
	expect(body).toContain('aria-label="Erase all stored commenter handles for this channel now"');
});

test('the danger zone renders even with an empty log', () => {
	const body = renderLog({ entries: [] });
	expect(body).toContain('aria-label="Erase all stored commenter handles for this channel now"');
});

test('a blocked comment with no audit entry renders a visible error and a confirmed new restore action', () => {
	const body = renderLog({ entries: [], recovery: [{ id: 'blocked', text: 'blocked text', restoreIntentId: 7 }] });
	expect(body).toContain('class="error-box"');
	expect(body).toContain('Automatic recovery is paused');
	expect(body).toContain('blocked text');
	expect(body).toContain('action="?/recoverRestore"');
	expect(body).toContain('name="expectedIntentId" value="7"');
	expect(body).toContain('name="confirmRestore"');
	expect(body).toContain('required');
	expect(body).toContain('publish this comment');
	expect(body).toContain('aria-label="Restore blocked comment blocked"');
});

test('members see an owner recovery instruction without a recovery form', () => {
	const body = renderLog({ recovery: [{ id: 'blocked', text: 'blocked text', restoreIntentId: null }], canRecover: false });
	expect(body).toContain('Ask your organization owner');
	expect(body).not.toContain('action="?/recoverRestore"');
});

test.each(['in_flight', 'uncertain'])('a %s write displays its paused-action explanation without a restore form', (state) => {
	const body = renderLog({ entries: [], dispatches: [{ id: 'blocked', text: 'Pending remote result', state }] });
	expect(body).toContain('Pending YouTube actions');
	expect(body).toContain('Pending remote result');
	expect(body).toContain('Further actions are paused');
	expect(body).toContain(state === 'uncertain' ? 'Contact support' : 'Check again shortly');
	expect(body).not.toContain('action="?/recoverRestore"');
});
