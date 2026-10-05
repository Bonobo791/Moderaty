import { render } from 'svelte/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ page: { url: new URL('https://moderaty.example/privacy') } }));
const navigation = vi.hoisted(() => ({ callback: undefined as undefined | ((event: {
	to: { url: URL } | null; willUnload: boolean; cancel: () => void
}) => void) }));
vi.mock('$app/navigation', () => ({ beforeNavigate: (callback: typeof navigation.callback) => { navigation.callback = callback; } }));
vi.mock('$app/state', () => state);
beforeEach(() => { state.page.url = new URL('https://moderaty.example/privacy'); });
vi.mock('$lib/analytics', async (original) => ({
	...await original<typeof import('$lib/analytics')>(),
	loadAnalytics: () => { throw new Error('SSR must not initialize browser analytics'); }
}));
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

test.each(['/login', '/account', '/consent?state=secret', '/contact/verify?token=secret', '/invite/secret', '/privacy?token=secret'])(
	'a document with GTM must unload before client navigation exposes %s', (path) => {
		render(Analytics);
		const assign = vi.fn();
		const cancel = vi.fn();
		vi.stubGlobal('document', { getElementById: () => ({ id: 'moderaty-gtm' }) });
		vi.stubGlobal('window', { location: { assign } });
		expect(navigation.callback).toBeTypeOf('function');
		navigation.callback?.({ to: { url: new URL(path, 'https://moderaty.example') }, willUnload: false, cancel });
		expect(cancel).toHaveBeenCalledOnce();
		expect(assign).toHaveBeenCalledWith(new URL(path, 'https://moderaty.example').href);
	}
);

test.each([
	{ loaded: false, path: '/account', willUnload: false },
	{ loaded: true, path: '/pricing', willUnload: false },
	{ loaded: true, path: '/account', willUnload: true }
])('safe or already unloading navigation preserves the router: %j', ({ loaded, path, willUnload }) => {
	render(Analytics);
	const assign = vi.fn();
	const cancel = vi.fn();
	vi.stubGlobal('document', { getElementById: () => loaded ? {} : null });
	vi.stubGlobal('window', { location: { assign } });
	expect(navigation.callback).toBeTypeOf('function');
	navigation.callback?.({ to: { url: new URL(path, 'https://moderaty.example') }, willUnload, cancel });
	expect(cancel).not.toHaveBeenCalled();
	expect(assign).not.toHaveBeenCalled();
});

test.each(['/contact', '/login', '/consent?state=secret', '/privacy?token=secret'])(
	'an excluded document entering a public page from %s preserves normal router navigation', (path) => {
		state.page.url = new URL(path, 'https://moderaty.example');
		render(Analytics);
		const assign = vi.fn();
		const cancel = vi.fn();
		vi.stubGlobal('document', { getElementById: () => null });
		vi.stubGlobal('window', { location: { assign } });
		navigation.callback?.({ to: { url: new URL('https://moderaty.example/privacy') }, willUnload: false, cancel });
		expect(cancel).not.toHaveBeenCalled();
		expect(assign).not.toHaveBeenCalled();
	}
);
