// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
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
