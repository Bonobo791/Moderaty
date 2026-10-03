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
 expect(welcomeOperationDiagnostic(missing)).toContain('migration 0062');
 expect(welcomeOperationDiagnostic(missing)).not.toContain('recipient@example.com');
 const connection = Object.assign(new Error('https://account:redaction-marker@example.invalid/path'), { code: 'SERVER_ERROR' });
 expect(welcomeOperationDiagnostic(connection)).toContain('database');
 expect(welcomeOperationDiagnostic(connection)).not.toContain('redaction-marker');
});
