// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Advanced Digital Marketing LTDA
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
