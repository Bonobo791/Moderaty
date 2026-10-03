import { expect, test } from 'vitest';
import { parseWelcomeArgs } from './welcome-email.mjs';

test('welcome operator command defaults to read-only count preview', () => {
 expect(parseWelcomeArgs([])).toEqual({ command: 'preview' });
 expect(parseWelcomeArgs(['status'])).toEqual({ command: 'status' });
});
test('backfill requires explicit confirmation and a bounded batch', () => {
 expect(parseWelcomeArgs(['enqueue', '--limit=3', '--confirm-enqueue', '--after=user-1'])).toEqual({ command: 'enqueue', limit: 3, afterUserId: 'user-1' });
 for (const args of [['enqueue'], ['enqueue', '--limit=25'], ['enqueue', '--limit=26', '--confirm-enqueue'], ['enqueue', '--limit=1.5', '--confirm-enqueue'], ['preview', '--confirm-enqueue'], ['send'], ['enqueue', '--limit=1', '--limit=2', '--confirm-enqueue']]) expect(() => parseWelcomeArgs(args)).toThrow();
});
