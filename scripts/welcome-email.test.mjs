import { expect, test } from 'vitest';
import { parseWelcomeArgs, welcomeOperationDiagnostic } from './welcome-email.mjs';

test('welcome operator command defaults to read-only count preview', () => {
 expect(parseWelcomeArgs([])).toEqual({ command: 'preview' });
 expect(parseWelcomeArgs(['status'])).toEqual({ command: 'status' });
});
test('backfill requires explicit confirmation and a bounded batch', () => {
 expect(parseWelcomeArgs(['enqueue', '--limit=3', '--confirm-enqueue', '--after=user-1'])).toEqual({ command: 'enqueue', limit: 3, afterUserId: 'user-1' });
 for (const args of [['enqueue'], ['enqueue', '--limit=25'], ['enqueue', '--limit=26', '--confirm-enqueue'], ['enqueue', '--limit=1.5', '--confirm-enqueue'], ['preview', '--confirm-enqueue'], ['send'], ['enqueue', '--limit=1', '--limit=2', '--confirm-enqueue']]) expect(() => parseWelcomeArgs(args)).toThrow();
});


test('operator diagnostics identify safe causes without echoing SQL, credentials or customer data', () => {
 expect(welcomeOperationDiagnostic(new Error('MODERATY_DEPLOYMENT must be official-hosted or self-hosted'))).toContain('MODERATY_DEPLOYMENT');
 expect(welcomeOperationDiagnostic(new Error('TURSO_DATABASE_URL is required'))).toContain('TURSO_DATABASE_URL');
 const missing = Object.assign(new Error('no such table: welcome_emails; recipient@example.com'), { code: 'SQLITE_ERROR' });
 expect(welcomeOperationDiagnostic(missing)).toContain('migrations 0062 and 0063');
 expect(welcomeOperationDiagnostic(missing)).not.toContain('recipient@example.com');
 const connection = Object.assign(new Error('https://account:redaction-marker@example.invalid/path'), { code: 'SERVER_ERROR' });
 expect(welcomeOperationDiagnostic(connection)).toContain('database');
 expect(welcomeOperationDiagnostic(connection)).not.toContain('redaction-marker');
});

test('real Drizzle wrappers retain actionable diagnostics without exposing query parameters', async () => {
 const { DrizzleQueryError } = await import('drizzle-orm');
 for (const [code, message, expected] of [
  ['SQLITE_ERROR', 'no such table: welcome_emails', 'migrations 0062 and 0063'],
  ['SQLITE_BUSY', 'database is busy', 'database is busy'],
  ['UNAUTHORIZED', 'credential rejected', 'rejected authentication']
 ]) {
  const cause = Object.assign(new Error(message), { code });
  const wrapped = new DrizzleQueryError('select private_fixture where email = ?', ['private-fixture@example.com'], cause);
  const diagnostic = welcomeOperationDiagnostic(wrapped);
  expect(diagnostic).toContain(expected);
  expect(diagnostic).not.toContain('private-fixture@example.com');
  expect(diagnostic).not.toContain('select private_fixture');
 }
});
test('diagnostic cause traversal is bounded even with cyclic error causes', () => {
 const cause = new Error('unknown wrapper'); cause.cause = cause;
 expect(welcomeOperationDiagnostic(cause)).toContain('database operation failed');
});
