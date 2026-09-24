import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';

// SSR render: $app/environment's `browser` is false here, which is exactly
// the case that used to drop the query string from the return path.
vi.mock('$app/state', () => ({
	page: { url: new URL('https://moderaty.example/consent?state=abc123') }
}));

import LanguageSwitcher from './LanguageSwitcher.svelte';

test('the return path keeps the query string under SSR (the /consent ?state= round-trip)', async () => {
	const { body } = render(LanguageSwitcher, { props: { locale: 'en' } });
	expect(body).toContain('value="/consent?state=abc123"');
});
