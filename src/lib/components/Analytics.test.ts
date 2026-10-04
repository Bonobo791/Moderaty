import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';

vi.mock('$lib/analytics', () => ({
	loadAnalytics: () => { throw new Error('SSR must not initialize browser analytics'); }
}));

import Analytics from './Analytics.svelte';

test('SSR and prerendering emit no GTM script, iframe, configuration or failure notice', () => {
	const { body, head } = render(Analytics);
	expect(body + head).not.toContain('googletagmanager');
	expect(body + head).not.toContain('<script');
	expect(body + head).not.toContain('<iframe');
	expect(body + head).not.toContain('GTM-');
	expect(body + head).not.toContain('unavailable');
});
