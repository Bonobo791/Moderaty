import { DrizzleQueryError } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { WelcomePreparationError, welcomeFailureCategory } from './welcomeDiagnostics';

test.each(['configuration', 'invalid_membership'] as const)('known preparation errors retain their safe %s category', category => {
 expect(welcomeFailureCategory(new WelcomePreparationError(category))).toBe(category);
});

test.each([
 ['SQLITE_BUSY', 'database_busy'], ['SQLITE_LOCKED', 'database_busy'],
 ['UNAUTHORIZED', 'database_authentication'], ['AUTH_ERROR', 'database_authentication'],
 ['SQLITE_ERROR', 'database_schema_or_query']
])('wrapped driver error %s gets an actionable fixed category without leaking context', (code, category) => {
 const driver = Object.assign(new Error('credential-bearing fixture'), { code });
 const wrapper = new DrizzleQueryError('SELECT private_fixture WHERE email = ?', ['private-fixture@example.com'], driver);
 expect(welcomeFailureCategory(wrapper)).toBe(category);
});

test('unknown, cyclic, and excessively deep failures do not leak raw context or loop', () => {
 const cycle = new Error('private context'); cycle.cause = cycle;
 for (const cause of [cycle, null, 'private context', new Error('private context')]) {
  expect(welcomeFailureCategory(cause)).toBe('unexpected_preparation_or_persistence');
 }
 let deep: Error = Object.assign(new Error('driver'), { code: 'SQLITE_BUSY' });
 for (let i = 0; i < 5; i++) deep = new Error('wrapper', { cause: deep });
 expect(welcomeFailureCategory(deep)).toBe('unexpected_preparation_or_persistence');
});
