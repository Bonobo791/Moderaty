// SSR render tests for the dashboard page (redesign Commit 4): the aggregate
// door-status header and the channel ledger. The load can report a mid-load
// outage (maintenance: true) AFTER the layout decided it is healthy, so the
// page must render its own maintenance state instead of destructive controls
// (PR #123 review — codeant). The per-channel controls (sensitivity,
// protections, history, dry run, disconnect) moved to the channel detail
// page — their pins live in channels/[id]/channel-page.test.ts; the
// delete-account flow moved to /account (Commit 5) — its pins live in
// account/account-page.test.ts.
//
// Gotchas: Svelte SSR inserts scoped-class hashes between class names, so
// class pins match a name inside the class attribute via regex; SSR can emit
// component doc comments, so pins target markup/visible copy, never words
// that only appear in comments.

import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, test } from 'vitest';

import Page from './+page.svelte';

const MAINTENANCE_DATA = { chs: [], stats: [], bans: [], maintenance: true, orgRole: null };

const CHS = [
	{
		id: 'UC1',
		title: 'My Channel',
		cursor: null,
		lastRunAt: '2026-08-01T00:00:00Z',
		lastRunStatus: 'success',
		lastSuccessAt: '2026-08-01T00:00:00Z',
		lastRunError: null,
		active: 1,
		toneLevel: 1,
		protectLgbtqia: 0,
		protectWomen: 0,
		scanning: false
	},
	{
		id: 'UC2',
		title: 'Second Channel',
		cursor: null,
		lastRunAt: '2026-07-30T00:00:00Z',
		lastRunStatus: 'success',
		lastSuccessAt: '2026-07-30T00:00:00Z',
		lastRunError: null,
		active: 1,
		toneLevel: 2,
		protectLgbtqia: 0,
		protectWomen: 0,
		scanning: false
	},
	{
		id: 'UC3',
		title: 'Third Channel',
		cursor: null,
		lastRunAt: null,
		lastRunStatus: null,
		lastSuccessAt: null,
		lastRunError: null,
		active: 1,
		toneLevel: 2,
		protectLgbtqia: 0,
		protectWomen: 0,
		scanning: false
	}
];

// Pending 5 (2+3 — no single channel has 5), rejected 4, approved 11 (5+6),
// banned 4 (3+1): the aggregate values are distinct from every per-channel
// cell, so the door-status readouts can only come from summing.
const PENDING_DATA = {
	chs: CHS,
	stats: [
		{ channelId: 'UC1', status: 'pending', n: 2 },
		{ channelId: 'UC2', status: 'pending', n: 3 },
		{ channelId: 'UC1', status: 'rejected', n: 4 },
		{ channelId: 'UC1', status: 'approved', n: 5 },
		{ channelId: 'UC2', status: 'approved', n: 6 }
	],
	bans: [
		{ channelId: 'UC1', n: 3 },
		{ channelId: 'UC2', n: 1 }
	],
	maintenance: false,
	orgRole: 'owner'
};

const QUIET_DATA = {
	...PENDING_DATA,
	stats: PENDING_DATA.stats.filter((s) => s.status !== 'pending')
};

const EMPTY_DATA = { chs: [], stats: [], bans: [], maintenance: false, orgRole: 'owner' };

function renderPage(data: unknown) {
	return render(Page, { props: { data } as never }).body;
}

/** The four door-status readouts, cut out so per-channel cells can't satisfy a pin. */
function doorStats(body: string): string {
	return body.slice(body.indexOf('door-stats'), body.indexOf('ledger-head'));
}

test('a mid-load outage renders a maintenance state and hides every destructive control', () => {
	const body = renderPage(MAINTENANCE_DATA);
	expect(body).toContain('role="alert"');
	expect(body).not.toContain('Delete my account');
	expect(body).not.toContain('Connect YouTube channel');
});

test('the all-clear headline and subline render when nothing is pending', () => {
	const body = renderPage(QUIET_DATA);
	expect(body).toContain("All clear. Nobody's being weird for once.");
	// UC3 has never run: only genuinely healthy channels count as protected
	// (MOD-8) — the headline cannot claim coverage the runs never proved.
	expect(body).toContain('2 of 3 channels protected — 1 waiting for a first check.');
});

test('the all-clear subline claims full protection only when every channel is healthy', () => {
	const healthy = { ...QUIET_DATA, chs: CHS.map((ch) => ({ ...ch, lastRunStatus: 'success', lastSuccessAt: ch.lastRunAt })) };
	const body = renderPage(healthy);
	expect(body).toContain('3 channels protected. Queue\'s clear. Zero main character behavior detected.');
});

test('the pending headline and subline render with the summed count', () => {
	const body = renderPage(PENDING_DATA);
	expect(body).toContain('5 comments acting sus.');
	expect(body).toContain(
		'5 comments are waiting for a decision. The pile isn\'t going to sort itself.'
	);
});

test('the four door-status counters are client-side sums across all channels', () => {
	const stats = doorStats(renderPage(PENDING_DATA));
	// Ticker SSR renders the final value inside its mono span.
	expect(stats).toContain('>5</span>'); // pending: 2 + 3
	expect(stats.match(/>4</g)).toHaveLength(2); // rejected 4, banned 3 + 1
	expect(stats).toContain('>11</span>'); // approved: 5 + 6
});

test('the pending stat is accent only when the sum is positive', () => {
	expect(doorStats(renderPage(PENDING_DATA)).match(/accent/g)?.length).toBeGreaterThanOrEqual(2);
	const quiet = doorStats(renderPage(QUIET_DATA));
	// All-clear: only the banned readout keeps the accent color.
	expect(quiet.match(/accent/g)).toHaveLength(1);
});

test('the stat labels are the spec caps labels', () => {
	const stats = doorStats(renderPage(PENDING_DATA));
	expect(stats).toContain('Pending');
	expect(stats).toContain('Rejected');
	expect(stats).toContain('Approved');
	expect(stats).toContain('Told to touch grass');
});

test('the ledger header names the section and the connection count', () => {
	const body = renderPage(PENDING_DATA);
	expect(body).toContain('Channels');
	expect(body).toContain('3 connected');
});

test('the ledger renders all nine columns', () => {
	const head = renderPage(PENDING_DATA).slice(0, renderPage(PENDING_DATA).indexOf('tbody'));
	for (const column of [
		'Channel',
		'Status',
		'Pending',
		'Held',
		'Rejected',
		'Deleted',
		'Approved',
		'Sensitivity',
		'Last checked'
	]) {
		expect(head).toContain(column);
	}
});

test('each ledger row navigates to the channel detail page and is keyboard-operable', () => {
	const body = renderPage(PENDING_DATA);
	expect(body).toContain('href="/channels/UC1"');
	expect(body).toContain('role="link"');
	expect(body).toContain('tabindex="0"');
	expect(body).toContain('aria-label="Open My Channel"');
});

test('the channel cell shows the name and the mono ID subline', () => {
	const body = renderPage(PENDING_DATA);
	expect(body).toContain('My Channel');
	expect(body).toContain('ID: UC1');
	expect(body).toMatch(/class="[^"]*\bcol-id\b[^"]*"/);
});

test('the status cell shows PROTECTED, queue is clear, or a pending-queue link', () => {
	const body = renderPage(PENDING_DATA);
	expect(body).toContain('Protected');
	// UC3 has no pending comments.
	expect(body).toContain('queue is clear');
	// UC1 has 2 pending — the subline links to its review queue.
	expect(body).toContain('2 comments waiting for review');
	expect(body).toContain('href="/channels/UC1/queue"');
});

test('a channel whose latest run failed is never presented as protected (MOD-8)', () => {
	const failed = {
		...QUIET_DATA,
		chs: CHS.map((ch) =>
			ch.id === 'UC2'
				? { ...ch, lastRunStatus: 'failed', lastRunError: 'token', lastRunAt: '2026-09-01T00:00:00Z', lastSuccessAt: '2026-08-01T00:00:00Z' }
				: ch
		)
	};
	const body = renderPage(failed);
	const row = rowFor(body, 'Second Channel');
	expect(row).toContain('Check failed');
	expect(row).not.toContain('Protected');
	// The user-actionable line, plus the success/attempt distinction —
	// "last success" is the honest freshness signal for a failed channel.
	expect(row).toContain('YouTube access expired — reconnect the channel');
	expect(row).toContain('last success');
	// The failure also counts against the door-status claim — UC3 never ran.
	expect(body).toContain('1 of 3 channels protected — 1 failed the last check, 1 waiting for a first check.');
});

test.each([
	{ category: 'quota', action: 'YouTube quota is exhausted' },
	{ category: 'credits', action: 'AI credits ran out' },
	{ category: 'scoring', action: 'AI scoring was unavailable' },
	{ category: 'timeout', action: 'The last check timed out' },
	{ category: 'error', action: 'The last check failed' },
	{ category: null, action: 'The last check failed' },
	{ category: 'unexpected-provider-detail', action: 'The last check failed' }
])('a "$category" failure maps to a safe actionable message', ({ category, action }) => {
	const failed = {
		...PENDING_DATA,
		chs: CHS.map((ch) => (ch.id === 'UC2' ? { ...ch, lastRunStatus: 'failed', lastRunError: category } : ch))
	};
	const row = rowFor(renderPage(failed), 'Second Channel');
	expect(row).toContain(action);
	expect(row).toContain('we retry on the next check');
	// Raw provider detail must never reach the page — only the safe copy.
	expect(row).not.toContain('unexpected-provider-detail');
});

test('a never-run channel waits for its first check instead of looking protected', () => {
	const row = rowFor(renderPage(PENDING_DATA), 'Third Channel');
	expect(row).toContain('Not checked yet');
	expect(row).not.toContain('Protected');
	expect(row).not.toContain('Check failed');
	// The queue state stays real underneath — nothing pending is still clear.
	expect(row).toContain('queue is clear');
});

test('a paused channel reads as paused — never protected, failed, or never-run (MOD-9)', () => {
	// Even with a healthy last-run record, a paused channel is not protected:
	// cron stops claiming it, so "Protected" would be a lie.
	const paused = {
		...QUIET_DATA,
		chs: CHS.map((ch) => (ch.id === 'UC2' ? { ...ch, active: 0 } : ch))
	};
	const body = renderPage(paused);
	const row = rowFor(body, 'Second Channel');
	expect(row).toContain('Paused');
	expect(row).not.toContain('Protected');
	expect(row).not.toContain('Check failed');
	expect(row).not.toContain('Not checked yet');
	expect(row).toContain('resume on the channel page');
	// UC2 paused + UC3 never-run → only UC1 counts as protected.
	expect(body).toContain('1 of 3 channels protected — 1 paused, 1 waiting for a first check.');
});

/** The markup of ONE ledger row, cut out so a sensitivity pin can never be
 * satisfied by another channel's cell. */
function rowFor(body: string, title: string): string {
	const start = body.indexOf(`aria-label="Open ${title}"`);
	expect(start, `ledger row for ${title} present`).toBeGreaterThanOrEqual(0);
	return body.slice(start, body.indexOf('</tr>', start));
}

test('the sensitivity cell renders the mini-track and the stop label', () => {
	const body = renderPage(PENDING_DATA);
	expect(body).toMatch(/class="[^"]*\bmini-track\b[^"]*"/);
	expect(body).toMatch(/class="[^"]*\bmini-fill\b[^"]*\bstrict\b[^"]*"|class="[^"]*\bstrict\b[^"]*\bmini-fill\b[^"]*"/);
	// ROW-SCOPED: UC1 is Edge Lord, UC2 and UC3 are Ackchyually — a wrong
	// row mapping must fail these pins, not just page-wide presence
	// (coderabbit).
	expect(rowFor(body, 'My Channel')).toContain('Edge Lord');
	expect(rowFor(body, 'My Channel')).not.toContain('Ackchyually');
	for (const title of ['Second Channel', 'Third Channel']) {
		expect(rowFor(body, title)).toContain('Ackchyually');
		expect(rowFor(body, title)).not.toContain('Edge Lord');
	}
});

test('the last-checked cell falls back to never and relativizes timestamps', () => {
	const body = renderPage(PENDING_DATA);
	expect(body).toContain('never');
});

test('the responsive collapse classes are present on the collapsible columns', () => {
	const body = renderPage(PENDING_DATA);
	for (const cls of ['col-held', 'col-rejected', 'col-deleted', 'col-approved', 'col-sensitivity', 'col-last']) {
		expect(body).toMatch(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`));
	}
});

test('the connect button and its helper copy render', () => {
	const body = renderPage(PENDING_DATA);
	expect(body).toContain('Connect YouTube channel');
	expect(body).toContain('href="/api/auth/google"');
	expect(body).toContain('Google sign-in required. Access is revocable anytime.');
	expect(body).toContain('Privacy Policy');
});

test('the delete-account flow moved to /account — the dashboard renders none of it', () => {
	const body = renderPage(PENDING_DATA);
	expect(body).not.toContain('Delete my account');
	expect(body).not.toContain('deleteAccount');
	expect(body).not.toContain('danger-zone');
	expect(body).not.toContain('name="confirm"');
	// The page ends after the privacy note: nothing follows it.
	expect(body.indexOf('Privacy Policy')).toBeGreaterThan(body.indexOf('ledger-head'));
});

test('the channel controls moved to the detail page — the dashboard renders none of them', () => {
	const body = renderPage(PENDING_DATA);
	expect(body).not.toContain('type="range"');
	expect(body).not.toContain('Analyze history');
	expect(body).not.toContain('Dry run');
	expect(body).not.toContain('Disconnect channel');
	expect(body).not.toContain('Strict protection');
});

test('the pending-queue link stops click propagation so the row handler cannot hijack its navigation (codeant, PR #142)', () => {
	// The anchor sits inside a row whose onclick navigates to the channel —
	// without stopPropagation the two navigations race (SSR strips handlers,
	// so this is a source pin, same pattern as i18n-coverage.test.ts).
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	const linkStart = source.indexOf('pending-link');
	expect(linkStart).toBeGreaterThan(-1);
	expect(source.slice(linkStart, linkStart + 400)).toContain('stopPropagation');
});

test('no channels renders the empty state and the quiet zero-count header', () => {
	const body = renderPage(EMPTY_DATA);
	expect(body).toContain('No channels connected');
	expect(body).toContain('0 connected');
	expect(body).toContain("All clear. Nobody's being weird for once.");
	expect(body).toContain('0 channels protected. Queue\'s clear. Zero main character behavior detected.');
});
