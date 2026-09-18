// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

// SSR render tests for the post-deletion confirmation page: the exact
// confirmation copy is the whole point of the page, so pin it verbatim in
// both locales, plus the way back to the landing page.

import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';

// The page mounts LanguageSwitcher (MOD-11), which reads $app/state's page.url
// for its return path — mock it the same way LanguageSwitcher.test.ts does.
vi.mock('$app/state', () => ({
	page: { url: new URL('https://moderaty.example/account-deleted') }
}));

import Page from './+page.svelte';

function renderPage(locale: 'en' | 'pt-BR') {
	return render(Page, { props: { data: { locale } } as never }).body;
}

test('renders the deletion confirmation verbatim (en)', () => {
	const body = renderPage('en');
	expect(body).toContain('Your account has been closed');
	expect(body).toContain('Your data is now deleted and your account has been closed.');
	expect(body).toContain('href="/"');
});

test('renders the deletion confirmation verbatim (pt-BR)', () => {
	const body = renderPage('pt-BR');
	expect(body).toContain('Sua conta foi encerrada');
	expect(body).toContain('Seus dados foram excluídos e sua conta foi encerrada.');
	expect(body).toContain('href="/"');
});

test('the confirmation acknowledges the legally retained consent record', () => {
	// The consents evidentiary log keeps the e-mail for ten years (LGPD Art.
	// 16, III); the cron sweep erases only consents.email — the anonymized row
	// itself is KEPT. The copy must promise exactly that, never that the whole
	// record is erased (codex P2).
	expect(renderPage('en')).toContain('the e-mail it contains is erased after ten years');
	expect(renderPage('pt-BR')).toContain('o e-mail que ele contém é apagado após dez anos');
});

// MOD-11: this page is fully translated, so it is one of the three surfaces
// permitted to offer the language selector.
test('the bilingual selector is mounted on this translated page', () => {
	const body = renderPage('en');
	expect(body).toContain('language-switcher');
	expect(body).toContain('name="locale"');
});
