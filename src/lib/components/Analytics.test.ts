import { render } from 'svelte/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const state = vi.hoisted(() => ({ page: { url: new URL('https://moderaty.example/privacy') } }));
const navigation = vi.hoisted(() => ({ callback: undefined as undefined | ((event: { to: { url: URL } | null; willUnload: boolean; cancel: () => void }) => void) }));
vi.mock('$app/navigation', () => ({ beforeNavigate: (callback: typeof navigation.callback) => { navigation.callback = callback; } }));
vi.mock('$app/state', () => state);
beforeEach(() => { state.page.url = new URL('https://moderaty.example/privacy'); navigation.callback = undefined; });
afterEach(() => vi.unstubAllGlobals());
import Analytics from './Analytics.svelte';
test('SSR emits no collector, tracking elements, identifiers or failure notice', () => {
	const { body, head } = render(Analytics);
	for (const forbidden of ['googletagmanager', 'collector.example', '<script', '<iframe', 'GTM-', 'unavailable']) expect(body + head).not.toContain(forbidden);
});
test.each(['/login', '/account', '/consent?state=secret', '/contact/verify?token=secret', '/invite/secret'])('private navigation to %s remains normal navigation', (path) => {
	expect(render(Analytics).body).not.toContain('<script'); const assign = vi.fn(); const cancel = vi.fn();
	vi.stubGlobal('document', { getElementById: vi.fn().mockReturnValue(true) }); vi.stubGlobal('window', { location: { assign } });
	expect(navigation.callback).toBeTypeOf('function');
	navigation.callback?.({ to: { url: new URL(path, state.page.url) }, willUnload: false, cancel });
	expect(cancel).not.toHaveBeenCalled(); expect(assign).not.toHaveBeenCalled();
});
