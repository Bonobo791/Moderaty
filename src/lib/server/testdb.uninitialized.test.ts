import { expect, test } from 'vitest';

import { testDb } from './testdb';

// Deliberately NO setupTestDb() call in this file: test files are isolated
// from each other, so the module-level holder stays null here. The guard must
// fail loudly with a descriptive error instead of leaking a null database —
// a silent null would surface as a confusing TypeError deep inside fixtures.
test('testDb() throws with a descriptive error before setupTestDb initializes it', () => {
	expect(() => testDb()).toThrow('test db not initialized — call setupTestDb() first');
});
