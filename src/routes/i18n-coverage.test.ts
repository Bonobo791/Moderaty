// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; see LICENSE.

// MOD-11 — the locale contract: only surfaces whose user-facing copy is
// fully translated for every supported locale may offer the selector and
// resolve the stored preference. The landing, the signed-in app, and the
// consent flow (its legal constants and server validation copy are
// English-only — codex+cubic, PR #142) stay English, so the selector lives
// exactly on the bilingual account pages and nowhere else. Source
// assertions, same pattern as consent/title.test.ts — a rendered check
// alone could not pin ABSENCE on the other surfaces.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { BILINGUAL_PATHS, isBilingualPath } from '$lib/i18n/locale';

const page = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const ROUTES_ROOT = new URL('.', import.meta.url).pathname;

/** Every +page.svelte/+layout.svelte under src/routes, relative to it. */
function routeTemplates(dir = ROUTES_ROOT, prefix = ''): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const rel = `${prefix}${entry.name}`;
		if (entry.isDirectory()) return routeTemplates(join(dir, entry.name), `${rel}/`);
		return /^\+(page|layout)\.svelte$/.test(entry.name) ? [rel] : [];
	});
}

// The only surfaces that may mount the selector — derived from the
// filesystem so a NEW English-only page can never sneak the selector in
// untested (cubic, PR #142).
const SELECTOR_PAGES = new Set(['login/+page.svelte', 'account-deleted/+page.svelte']);

test('the bilingual allowlist covers exactly the fully translated account pages', () => {
	expect([...BILINGUAL_PATHS].sort()).toEqual(['/account-deleted', '/login']);
	// The allowlist is the single source the layout/hooks gate on — every
	// bilingual page must be in it, and no English-only surface may be.
	expect(isBilingualPath('/login')).toBe(true);
	expect(isBilingualPath('/account-deleted')).toBe(true);
	expect(isBilingualPath('/')).toBe(false);
	expect(isBilingualPath('/dashboard')).toBe(false);
	expect(isBilingualPath('/channels/UC1')).toBe(false);
	// The consent flow is English-only: its legally operative sentence,
	// refund/privacy notices, and server validation copy come from English
	// constants the evidence log stores verbatim — a selector would wrap
	// English legal text in pt-BR chrome, the exact partial translation
	// MOD-11 exists to prevent (codex+cubic, PR #142).
	expect(isBilingualPath('/consent')).toBe(false);
	// A stray trailing slash must not silently flip a bilingual page English.
	expect(isBilingualPath('/login/')).toBe(true);
});

test.each([...SELECTOR_PAGES])('%s mounts the language selector with the resolved locale', (path) => {
	expect(page(path)).toContain('LanguageSwitcher');
	expect(page(path)).toContain('locale={data.locale}');
});

test.each(routeTemplates().filter((path) => !SELECTOR_PAGES.has(path)))(
	'%s does NOT offer the selector — it is English-only',
	(path) => {
		expect(page(path)).not.toContain('LanguageSwitcher');
	}
);

test.each([...SELECTOR_PAGES])('%s keeps the selector out of flow so its 100vh main does not overflow', (path) => {
	// An in-flow bar above a min-height:100vh main makes the page taller than
	// the viewport — pointless scroll on a one-card screen (codeant, PR #142).
	expect(page(path)).toContain('switcher-bar');
	expect(page(path)).toMatch(/\.switcher-bar\s*\{[^}]*position:\s*absolute/);
});

test('the root layout keeps html lang in sync on client-side navigation', () => {
	// hooks.server.ts only rewrites lang on a full page load: after soft
	// navigation away from a bilingual page the attribute must still
	// describe the rendered surface (cubic, PR #142).
	expect(page('./+layout.svelte')).toContain('document.documentElement.lang');
});
