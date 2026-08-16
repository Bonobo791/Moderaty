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
	expect(body).toContain('aria-label="Set sensitivity to Chill Pepe"');
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
	expect(body).toContain('aria-valuetext="CHILL PEPE"');
});

test('the strict stop reports 100 and the Ackchyually mode name to screen readers', () => {
	const body = renderSwitch(2);
	expect(body).toContain('aria-valuenow="100"');
	expect(body).toContain('aria-valuetext="EDGE LORD + ACKCHYUALLY..."');
});

// ── readout ────────────────────────────────────────────────────────────

test('the chill readout renders the CHILL stop label and the verbatim Chill Pepe copy', () => {
	const body = renderSwitch(1);
	expect(body).toContain('>CHILL</span>');
	expect(body).toContain('CHILL PEPE');
	expect(body).toContain('Only clear hate speech and spam get bounced. Snark survives.');
	expect(body).not.toContain('Hateful comments and demeaning, condescending, or sarcastic tone are moderated.');
});

test('the strict readout renders the STRICT stop label and the verbatim strict copy', () => {
	const body = renderSwitch(2);
	expect(body).toContain('>STRICT</span>');
	expect(body).toContain('Hateful comments and demeaning, condescending, or sarcastic tone are moderated.');
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
