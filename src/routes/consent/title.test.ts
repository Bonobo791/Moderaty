import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('the consent page title carries the "Moderaty — " prefix like every other page', () => {
	// Source assertion (same pattern as app.test.ts): the page's <svelte:head>
	// template must brand the localized title (cubic, PR #136 round 2).
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	expect(source).toContain("<title>Moderaty — {t(data.locale, 'finishAccount')}</title>");
});
