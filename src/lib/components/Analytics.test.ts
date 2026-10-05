import { render } from 'svelte/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ page: { url: new URL('https://moderaty.example/privacy') } }));
const navigation = vi.hoisted(() => ({ callback: undefined as undefined | ((event: {
	to: { url: URL } | null; willUnload: boolean; cancel: () => void
}) => void) }));
vi.mock('$app/navigation', () => ({ beforeNavigate: (callback: typeof navigation.callback) => { navigation.callback = callback; } }));
vi.mock('$app/state', () => state);
beforeEach(() => {
	state.page.url = new URL('https://moderaty.example/privacy');
	navigation.callback = undefined;
});
afterEach(() => vi.unstubAllGlobals());

import Analytics from './Analytics.svelte';

test('SSR and prerendering emit no GTM script, iframe, configuration or failure notice', () => {
	const { body, head } = render(Analytics);
	expect(body + head).not.toContain('googletagmanager');
	expect(body + head).not.toContain('<script');
	expect(body + head).not.toContain('<iframe');
	expect(body + head).not.toContain('GTM-');
	expect(body + head).not.toContain('unavailable');
});

// source, destination, existing script, already unloading, expected forced navigation
// One matrix exercises the real registered callback for both privacy and normal routing.
test.each([
	['/privacy', '/login', true, false, 1],
	['/privacy', '/account', true, false, 1],
	['/privacy', '/consent?state=secret', true, false, 1],
	['/privacy', '/contact/verify?token=secret', true, false, 1],
	['/privacy', '/invite/secret', true, false, 1],
	['/privacy', '/privacy?token=secret', true, false, 1],
	['/privacy', '/account', false, false, 0],
	['/privacy', '/pricing', true, false, 0],
	['/privacy', '/account', true, true, 0],
	['/contact', '/privacy', false, false, 0],
	['/login', '/privacy', false, false, 0],
	['/consent?state=secret', '/privacy', false, false, 0],
	['/privacy?token=secret', '/privacy', false, false, 0]
] as const)('navigation %s → %s (GTM: %s, unloading: %s) forces %s document navigation', (from, to, loaded, willUnload, forced) => {
	state.page.url = new URL(from, 'https://moderaty.example');
	// Svelte SSR renders lazily; read the body to register this instance's guard.
	expect(render(Analytics).body).not.toContain('googletagmanager');
	const assign = vi.fn();
	const cancel = vi.fn();
	const url = new URL(to, 'https://moderaty.example');
	vi.stubGlobal('document', { getElementById: vi.fn().mockReturnValue(loaded) });
	vi.stubGlobal('window', { location: { assign } });
	expect(navigation.callback).toBeTypeOf('function');
	navigation.callback?.({ to: { url }, willUnload, cancel });
	expect(cancel).toHaveBeenCalledTimes(forced);
	expect(assign).toHaveBeenCalledTimes(forced);
	if (forced) expect(assign).toHaveBeenCalledWith(url.href);
});
