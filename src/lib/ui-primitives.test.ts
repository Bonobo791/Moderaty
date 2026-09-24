// SSR pins for the redesign primitives (Commit 1): Ticker renders its
// target value directly under SSR (the rAF tween is client-only) and
// SharpCheckbox enforces the I13 labeling rule loudly.

import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, test } from 'vitest';

import SharpCheckbox from './SharpCheckbox.svelte';
import Ticker from './Ticker.svelte';

test('Ticker SSR renders the rounded target value with the mono class', () => {
	const { body } = render(Ticker, { props: { value: 42 } });
	expect(body).toContain('class="mono"');
	expect(body).toContain('>42</span>');
});

test('Ticker reads the animated value inside the effect via untrack (no self-restart loop)', () => {
	// The $effect writes `shown` from its rAF tick; reading `shown` bare would
	// make the effect depend on its own output and re-trigger every frame
	// (codex). SSR cannot run effects, so pin the source contract directly.
	const source = readFileSync(new URL('./Ticker.svelte', import.meta.url), 'utf8');
	const effectBody = source.slice(source.indexOf('$effect('));
	expect(effectBody).toContain('untrack(() => shown');
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
