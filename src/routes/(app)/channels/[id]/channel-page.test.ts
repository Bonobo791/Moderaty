// SSR render tests for the channel detail shell (layout header + tab bar)
// and the overview page (the controls moved from the dashboard cards).
// Svelte's SSR render is lazy: assert on render(...).body.

import { readFileSync } from 'node:fs';
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
		lastRunStatus: 'success',
		lastRunError: null,
		lastSuccessAt: '2026-09-01T00:00:00.000Z',
		toneLevel: 1,
		protectLgbtqia: 1,
		protectWomen: 0,
		active: 1,
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
	expect(body).toContain('Told to touch grass');
});

test('a paused channel header says Paused — never Protected or "queue is clear" (codex+cubic, PR #142)', () => {
	// The overview's paused banner contradicts an unconditional "Protected"
	// header on the same page — the header branches on active like the
	// dashboard status cell does.
	const body = renderLayout({ ...LAYOUT_DATA, ch: { ...LAYOUT_DATA.ch, active: 0 } });
	expect(body).toContain('Paused');
	expect(body).not.toContain('Protected');
	expect(body).not.toContain('queue is clear');
});

test('a failed channel header says Check failed — never Protected (codex, PR #142 r2)', () => {
	// The dashboard's Check failed state must survive onto the channel's own
	// tabs — an unconditional Protected would contradict it on the same row.
	const body = renderLayout({
		...LAYOUT_DATA,
		ch: { ...LAYOUT_DATA.ch, lastRunStatus: 'failed', lastRunError: 'quota' }
	});
	expect(body).toContain('Check failed');
	expect(body).toContain('quota is exhausted');
	expect(body).not.toContain('Protected');
	expect(body).not.toContain('queue is clear');
});

test('a never-checked channel header says Not checked yet (codex, PR #142 r2)', () => {
	const body = renderLayout({
		...LAYOUT_DATA,
		ch: { ...LAYOUT_DATA.ch, lastRunStatus: null, lastRunError: null, lastSuccessAt: null }
	});
	expect(body).toContain('Not checked yet');
	expect(body).not.toContain('Protected');
});

test('a paused channel with a queue still links to it from the header status', () => {
	const body = renderLayout({ ...LAYOUT_DATA, pending: 4, ch: { ...LAYOUT_DATA.ch, active: 0 } });
	expect(body).toContain('Paused');
	expect(body).toContain('href="/channels/UC1/queue"');
	expect(body).toContain('4 comments waiting for review');
});

test('a non-zero pending count links to the queue from the header status', () => {
	const body = renderLayout({ ...LAYOUT_DATA, pending: 2 });
	expect(body).toContain('href="/channels/UC1/queue"');
	expect(body).toContain('2 comments waiting for review');
	expect(body).not.toContain('queue is clear');
});

// ── layout: tab bar ────────────────────────────────────────────────────

test('the tab bar is a tablist with all five section links and the queue count in the label', () => {
	const body = renderLayout({ ...LAYOUT_DATA, pending: 3 });
	expect(body).toContain('role="tablist"');
	expect(body).toContain('href="/channels/UC1"');
	expect(body).toContain('href="/channels/UC1/rules"');
	expect(body).toContain('href="/channels/UC1/queue"');
	expect(body).toContain('href="/channels/UC1/feedback"');
	expect(body).toContain('href="/channels/UC1/log"');
	expect(body).toContain('Review queue (3)');
	expect(body).toContain('Overview');
	expect(body).toContain('Rules');
	expect(body).toContain('Feedback');
	expect(body).toContain('Audit log');
});

test.each([
	{ tab: 'overview', href: '/channels/UC1"', selected: 'aria-selected="true"' },
	{ tab: 'rules', href: '/channels/UC1/rules', selected: 'aria-selected="true"' },
	{ tab: 'queue', href: '/channels/UC1/queue', selected: 'aria-selected="true"' },
	{ tab: 'feedback', href: '/channels/UC1/feedback', selected: 'aria-selected="true"' },
	{ tab: 'log', href: '/channels/UC1/log', selected: 'aria-selected="true"' }
])('the "$tab" tab is aria-selected when active', ({ tab, href }) => {
	const body = renderLayout({ ...LAYOUT_DATA, tab });
	// The active tab carries aria-selected="true"; exactly one tab does.
	expect(body.match(/aria-selected="true"/g)).toHaveLength(1);
	expect(body).toContain(`href="${href}`);
	// Inactive tabs are explicitly unselected (tablist semantics).
	expect(body.match(/aria-selected="false"/g)).toHaveLength(4);
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

test('the sensitivity control renders the two-stop switch with both meme endpoints', () => {
	const body = renderPage(LAYOUT_DATA);
	expect(body).not.toContain('type="range"');
	expect(body).toContain('role="slider"');
	expect(body).toContain('aria-label="Moderation sensitivity for My Channel"');
	expect(body).toContain('aria-label="Set sensitivity to Edge Lord"');
	expect(body).toContain('aria-label="Set sensitivity to Edge Lord plus Ackchyually"');
	expect(body).toContain('src="/edge-lord.jpg"');
	expect(body).toContain('src="/ackchyually.gif"');
	expect(body).toContain('EDGE LORD');
	expect(body).toContain('EDGE LORD + ACKCHYUALLY');
	expect(body).toContain('Only clear hate speech and spam get yeeted. Snark survives.');
});

test('the sensitivity readout switches copy at the strict level', () => {
	const body = renderPage({ ...LAYOUT_DATA, ch: { ...LAYOUT_DATA.ch, toneLevel: 2 } });
	expect(body).toContain('STRICT');
	expect(body).toContain('Demeaning, condescending, or sarcastic tone gets hidden — never deleted. The edge lord has entered the chat.');
});

test('the switch persists through the setToneLevel action with the hidden fields the action requires', () => {
	const body = renderPage(LAYOUT_DATA);
	expect(body).toContain('action="?/setToneLevel"');
	expect(body).toContain('name="toneLevel" value="1"');
	const strict = renderPage({ ...LAYOUT_DATA, ch: { ...LAYOUT_DATA.ch, toneLevel: 2 } });
	expect(strict).toContain('name="toneLevel" value="2"');
});

test('strict protection renders both labeled checkboxes with their persisted state', () => {
	const body = renderPage(LAYOUT_DATA);
	expect(body).toContain('Strict protection');
	expect(body).toContain('Harassment targeting LGBTQIA+ people');
	expect(body).toContain('Harassment targeting women');
	expect(body).toContain('for="protect-lgbtqia-UC1"');
	expect(body).toContain('for="protect-women-UC1"');
	// The action persists by field presence — the names are the write path.
	expect(body).toContain('name="protectLgbtqia"');
	expect(body).toContain('name="protectWomen"');
	expect(body).toContain('Heightened AI scrutiny for these comments, at any sensitivity level.');
});

// SSR can never drive an enhanced-form result in the node test env, so the
// save-while-changing wiring is pinned at source level (same convention as
// SensitivitySwitch.test.ts) — deleting it must fail a test, not slip
// through as a silent UI regression.
test('the protection checkboxes render local intent, not the raw server row', () => {
	// While a save is in flight the boxes must show the user's tick — a
	// mid-save invalidation (autoRefresh every 15s, or the submit's own
	// update) would otherwise snap them back to the pre-save state, and a
	// submit serialized in that window writes the wrong whole-row state.
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	expect(source).toMatch(/checked=\{lgbtqiaChecked\}/);
	expect(source).toMatch(/checked=\{womenChecked\}/);
	expect(source).toMatch(/protectLgbtqia \?\? ch\.protectLgbtqia === 1/);
	expect(source).toMatch(/protectWomen \?\? ch\.protectWomen === 1/);
});

test('the protections form never resets to stale checked state and serializes one save at a time', () => {
	// enhance's default update() resets the form on success — restoring
	// defaultChecked snaps a just-ticked box back to unchecked (the flicker).
	// And setProtections writes BOTH columns from field presence/absence, so
	// a second submit racing the first is a last-writer-wins snapshot that
	// clears the other flag — a mid-flight change must queue and re-fire on
	// settle carrying the latest intent of both boxes.
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	expect(source).toMatch(/await update\(\{ reset: false \}\)/);
	expect(source).toMatch(/if \(protectionsSaving\)[^}]*protectionsQueued = true/);
	expect(source).toMatch(/protectionsQueued = false;\s*protectionsForm\?\.requestSubmit\(\)/s);
});

test('a protection override releases only when the server row echoes it — failures revert', () => {
	// update() resolves on superseded invalidations too (a racing tone save,
	// the 15s autoRefresh): pre-commit data can still be showing at settle,
	// so clearing the override there would snap the box back and poison the
	// next whole-row submit. The echo effect is the release; a failed save
	// reverts to the persisted row instead (MOD-10).
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	expect(source).toMatch(/\(ch\.protectLgbtqia === 1\) === protectLgbtqia\) protectLgbtqia = null/);
	expect(source).toMatch(/\(ch\.protectWomen === 1\) === protectWomen\) protectWomen = null/);
	// The revert must live INSIDE the failure branch — a bare substring check
	// passes even if the branch stops clearing the overrides — and the
	// failure must surface as the scoped, visible alert (cubic, PR #147).
	expect(source).toMatch(/else if \(result\.type !== 'success'\)[^}]*protectLgbtqia = null;\s*protectWomen = null;/s);
	expect(source).toMatch(/form\?\.scope === 'protections' && form\?\.error/);
});

test('navigating to another channel drops pending protection intent and remounts the switch (cubic, PR #147)', () => {
	// /channels/A → /channels/B is a param-only navigation — SvelteKit reuses
	// this component, so stale overrides would render on B's boxes and a
	// queued settle-refire would serialize them into B's row. The switch is
	// keyed so its pending debounce/intent state dies with A too.
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	expect(source).toMatch(/\{#key ch\.id\}/);
	expect(source).toMatch(
		/ch\.id !== lastChannelId\) \{\s*protectLgbtqia = null;\s*protectWomen = null;\s*protectionsQueued = false;/s
	);
});

test('a queued protection re-fire freezes both boxes to the displayed intent (codeant, PR #147)', () => {
	// The re-fire serializes the live checkboxes — a stale pre-commit landing
	// between queue and refire would write its outdated value into the
	// untouched column (setProtections writes the whole row from field
	// presence). Freezing both overrides at queue time keeps the payload the
	// user's displayed intent.
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	expect(source).toMatch(
		/protectionsQueued = true;[\s\S]{0,500}protectLgbtqia \?\?= lgbtqiaChecked;\s*protectWomen \?\?= womenChecked;/
	);
});

test('the echo release cannot clear protection overrides while a save is in flight or queued (codex+coderabbit, PR #147)', () => {
	// Toggle on → toggle back mid-flight: the second value equals the stale
	// pre-commit row, so an unguarded echo check clears the override — the
	// first save's landing then displays the committed value and the queued
	// re-fire serializes it, persisting the opposite of the user's final
	// choice. Same guard as SensitivitySwitch's echo release.
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	expect(source).toMatch(/if \(protectionsSaving \|\| protectionsQueued\) return/);
});

test('an unechoed protection override releases on a bounded timer (codex, PR #147)', () => {
	// A concurrent write after our commit can mean the echo never lands —
	// unbounded overrides would mask every 15s autoRefresh forever, and a
	// later whole-row submit would rewrite the stale value over the newer
	// server change.
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	expect(source).toMatch(/armIntentRelease\(\(\) => \{\s*protectLgbtqia = null;\s*protectWomen = null;/s);
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
	// Pause/resume, sensitivity, protections, history, dry run, disconnect: six hidden fields.
	expect(body.match(/name="channelId" value="UC1"/g)).toHaveLength(6);
});

// ── overview page: pause/resume (MOD-9) ─────────────────────────────────

test('an active channel offers a labeled pause control posting paused=true', () => {
	const body = renderPage(LAYOUT_DATA);
	expect(body).toContain('action="?/setPaused"');
	expect(body).toContain('name="paused" value="true"');
	expect(body).toContain('Pause moderation on My Channel');
	// No pause state is claimed while the channel is live.
	expect(body).not.toContain('Moderation is paused');
	expect(body).not.toContain('Resume moderation');
});

test('a paused channel shows the paused banner and a resume control posting paused=false', () => {
	const body = renderPage({ ...LAYOUT_DATA, ch: { ...LAYOUT_DATA.ch, active: 0 } });
	expect(body).toContain('Moderation is paused for My Channel');
	expect(body).toContain('cron skips it');
	expect(body).toContain('name="paused" value="false"');
	expect(body).toContain('Resume moderation on My Channel');
	expect(body).not.toContain('Pause moderation on My Channel');
});

test('a paused channel hides the scan controls — they can only silently skip (codex, PR #142 r2)', () => {
	// Analyze history and Dry run both depend on a cron claim gated on
	// active=1, and runChannel short-circuits inactive channels — on a paused
	// channel the buttons would "succeed" while doing nothing.
	const body = renderPage({ ...LAYOUT_DATA, ch: { ...LAYOUT_DATA.ch, active: 0, scanning: true } });
	expect(body).not.toContain('action="?/analyzeHistory"');
	expect(body).not.toContain('action="?/dryRun"');
	expect(body).not.toContain('History scan in progress');
});

test('a paused-channel failure renders the scoped error', () => {
	const body = renderPage(LAYOUT_DATA, { scope: 'pause', channelId: 'UC1', error: 'channel not found' });
	expect(body).toContain('role="alert"');
	expect(body).toContain('channel not found');
});
