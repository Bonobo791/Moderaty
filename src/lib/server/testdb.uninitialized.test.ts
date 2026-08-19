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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { expect, test } from 'vitest';

import { testDb } from './testdb';

// Deliberately NO setupTestDb() call in this file: test files are isolated
// from each other, so the module-level holder stays null here. The guard must
// fail loudly with a descriptive error instead of leaking a null database —
// a silent null would surface as a confusing TypeError deep inside fixtures.
test('testDb() throws with a descriptive error before setupTestDb initializes it', () => {
	expect(() => testDb()).toThrow('test db not initialized — call setupTestDb() first');
});
