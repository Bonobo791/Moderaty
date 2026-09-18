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

// MOD-11 — the locale contract: only surfaces whose user-facing copy is
// fully translated for every supported locale may offer the selector and
// resolve the stored preference. The landing and the signed-in app are
// English-only today, so the selector lives exactly on the bilingual
// account pages and nowhere else. Source assertions, same pattern as
// consent/title.test.ts — a rendered check alone could not pin ABSENCE on
// the other surfaces.

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import { BILINGUAL_PATHS, isBilingualPath } from '$lib/i18n/locale';

const page = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the bilingual allowlist covers exactly the fully translated account pages', () => {
	expect([...BILINGUAL_PATHS].sort()).toEqual(['/account-deleted', '/consent', '/login']);
	// The allowlist is the single source the layout/hooks gate on — every
	// bilingual page must be in it, and no English-only surface may be.
	expect(isBilingualPath('/login')).toBe(true);
	expect(isBilingualPath('/consent')).toBe(true);
	expect(isBilingualPath('/account-deleted')).toBe(true);
	expect(isBilingualPath('/')).toBe(false);
	expect(isBilingualPath('/dashboard')).toBe(false);
	expect(isBilingualPath('/channels/UC1')).toBe(false);
	// A stray trailing slash must not silently flip a bilingual page English.
	expect(isBilingualPath('/login/')).toBe(true);
});

test.each(['login/+page.svelte', 'consent/+page.svelte', 'account-deleted/+page.svelte'])(
	'%s mounts the language selector with the resolved locale',
	(path) => {
		expect(page(path)).toContain('LanguageSwitcher');
		expect(page(path)).toContain('locale={data.locale}');
	}
);

test.each([
	'./+layout.svelte',
	'./+page.svelte',
	'(app)/+layout.svelte',
	'(app)/dashboard/+page.svelte',
	'(app)/channels/[id]/+page.svelte'
])('%s does NOT offer the selector — it is English-only', (path) => {
	expect(page(path)).not.toContain('LanguageSwitcher');
});
