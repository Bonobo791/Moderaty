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

// SSR pins for the redesign primitives (Commit 1): Ticker renders its
// target value directly under SSR (the rAF tween is client-only) and
// SharpCheckbox enforces the I13 labeling rule loudly.

import { render } from 'svelte/server';
import { expect, test } from 'vitest';

import SharpCheckbox from './SharpCheckbox.svelte';
import Ticker from './Ticker.svelte';

test('Ticker SSR renders the rounded target value with the mono class', () => {
	const { body } = render(Ticker, { props: { value: 42 } });
	expect(body).toContain('class="mono"');
	expect(body).toContain('>42</span>');
});

test('SharpCheckbox throws without a label or aria-label (I13, fail loudly)', () => {
	// NOTE: `render(...).body` — Svelte SSR render is lazy; the component only
	// executes when `body` is read, so the assertion must access it to throw.
	expect(() => render(SharpCheckbox, { props: {} }).body).toThrow(/I13/);
});

test('SharpCheckbox renders its visible label text', () => {
	const { body } = render(SharpCheckbox, { props: { checked: true, label: 'I understand' } });
	expect(body).toContain('type="checkbox"');
	expect(body).toContain('checked');
	expect(body).toContain('I understand');
});

test('SharpCheckbox falls back to the aria-label when there is no visible label', () => {
	const { body } = render(SharpCheckbox, { props: { ariaLabel: 'Acknowledge deletion' } });
	expect(body).toContain('aria-label="Acknowledge deletion"');
});
