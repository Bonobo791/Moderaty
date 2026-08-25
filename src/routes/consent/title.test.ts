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

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('the consent page title carries the "Moderaty — " prefix like every other page', () => {
	// Source assertion (same pattern as app.test.ts): the page's <svelte:head>
	// template must brand the localized title (cubic, PR #136 round 2).
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	expect(source).toContain("<title>Moderaty — {t(data.locale, 'finishAccount')}</title>");
});
