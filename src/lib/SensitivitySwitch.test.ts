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

// SSR pins for the two-stop sensitivity switch (Commit 3, spec §7/Step 3.2):
// both meme endpoints, the role="slider" ARIA contract, the per-level
// readout copy, the knob stop positions, and the hidden persistence form.
// Svelte's SSR render is lazy: assert on render(...).body.

import { render } from 'svelte/server';
import { expect, test } from 'vitest';

import SensitivitySwitch from './SensitivitySwitch.svelte';

function renderSwitch(level: number) {
	return render(SensitivitySwitch, {
		props: { channelId: 'UC1', channelTitle: 'My Channel', level } as never
	}).body;
}

// ── endpoints ──────────────────────────────────────────────────────────

test('both meme endpoints render as labeled buttons with their images', () => {
	const body = renderSwitch(1);
	expect(body).toContain('aria-label="Set sensitivity to Edge Lord"');
	expect(body).toContain('aria-label="Set sensitivity to Edge Lord plus Ackchyually"');
	expect(body).toContain('src="/edge-lord.jpg"');
	expect(body).toContain('src="/ackchyually.gif"');
	expect(body).toContain('EDGE LORD');
	expect(body).toContain('EDGE LORD + ACKCHYUALLY');
});

test('the inactive endpoint is dimmed and the active one is not', () => {
	// Scoped-class hashes sit between the pinned classes in SSR output, so
	// match the class attribute, not a literal class string.
	const chill = renderSwitch(1);
	expect(chill).toMatch(/class="endpoint strict[^"]*\binactive\b/);
	expect(chill).not.toMatch(/class="endpoint chill[^"]*\binactive\b/);
	const strict = renderSwitch(2);
	expect(strict).toMatch(/class="endpoint chill[^"]*\binactive\b/);
	expect(strict).not.toMatch(/class="endpoint strict[^"]*\binactive\b/);
});

// ── slider ARIA contract ───────────────────────────────────────────────

test('the track is a focusable slider with the full ARIA value contract', () => {
	const body = renderSwitch(1);
	expect(body).toContain('role="slider"');
	expect(body).toContain('tabindex="0"');
	expect(body).toContain('aria-label="Moderation sensitivity for My Channel"');
	expect(body).toContain('aria-valuemin="0"');
	expect(body).toContain('aria-valuemax="100"');
	expect(body).toContain('aria-valuenow="0"');
	expect(body).toContain('aria-valuetext="EDGE LORD"');
});

test('the strict stop reports 100 and the Ackchyually mode name to screen readers', () => {
	const body = renderSwitch(2);
	expect(body).toContain('aria-valuenow="100"');
	expect(body).toContain('aria-valuetext="EDGE LORD + ACKCHYUALLY..."');
});

// ── readout ────────────────────────────────────────────────────────────

test('the edge lord readout renders the EDGE LORD stop label and the verbatim chill copy', () => {
	const body = renderSwitch(1);
	expect(body).toContain('>EDGE LORD</span>');
	expect(body).toContain('Only clear hate speech and spam get yeeted. Snark survives.');
	expect(body).not.toContain('Hateful comments and demeaning, condescending, or sarcastic tone get moderated. The edge lord has entered the chat.');
	// At level 1 the mode name EQUALS the stop label — the duplicate
	// mode-name element must be hidden, or the readout reads "EDGE LORD
	// EDGE LORD" (coderabbit).
	expect(body).not.toContain('mode-name');
});

test('the strict readout renders the STRICT stop label and the verbatim strict copy', () => {
	const body = renderSwitch(2);
	expect(body).toContain('>STRICT</span>');
	expect(body).toContain('Hateful comments and demeaning, condescending, or sarcastic tone get moderated. The edge lord has entered the chat.');
	// Level 2 shows the distinct mode name under the stop label — a missing
	// mode-name here must fail the test (coderabbit).
	expect(body).toMatch(/class="[^"]*\bmode-name\b[^"]*">EDGE LORD \+ ACKCHYUALLY\.\.\.<\/span>/);
});

test('only the strict stop label carries the accent class', () => {
	expect(renderSwitch(1)).not.toMatch(/class="mode-stop mono[^"]*\bstrict\b/);
	expect(renderSwitch(2)).toMatch(/class="mode-stop mono[^"]*\bstrict\b/);
});

// ── knob positioning (spec Step 3.2: left: calc({v}% + {20 − v·0.4}px)) ──

test('the knob sits fully inside the track at both stops', () => {
	expect(renderSwitch(1)).toContain('calc(0% + 20px)');
	expect(renderSwitch(2)).toContain('calc(100% - 20px)');
});

// ── persistence form (§6.5: same action, 1|2 values) ──────────────────

test('the hidden form posts toneLevel and channelId to the setToneLevel action', () => {
	const body = renderSwitch(1);
	expect(body).toContain('action="?/setToneLevel"');
	expect(body).toContain('name="channelId" value="UC1"');
	expect(body).toContain('name="toneLevel" value="1"');
	expect(renderSwitch(2)).toContain('name="toneLevel" value="2"');
});

test('the Applied indicator only renders after a successful persist', () => {
	// Pin the live-region markup — the word also appears in the component's
	// doc comment, which SSR emits.
	expect(renderSwitch(1)).not.toContain('role="status"');
	expect(renderSwitch(1)).not.toMatch(/class="applied/);
});
