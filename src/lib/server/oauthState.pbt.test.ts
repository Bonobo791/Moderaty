import fc from 'fast-check';
import type { Cookies } from '@sveltejs/kit';
import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: { APP_URL: 'https://moderaty.example' } as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));

import { OAUTH_STATE_COOKIE, readPendingStates, storePendingStates } from './oauthState';
// Side-effect import: configures fast-check numRuns globally (FC_NUM_RUNS).
import './testarbitraries';

/**
 * In-memory Cookies stub (same shape as oauthState.test.ts's fakeCookies, but
 * backed by a Map) so store-then-read round-trips through the real code.
 */
function cookieJar(): { cookies: Cookies; jar: Map<string, string> } {
	const jar = new Map<string, string>();
	const cookies = {
		set: (name: string, value: string) => {
			jar.set(name, value);
		},
		get: (name: string) => jar.get(name),
		delete: (name: string) => {
			jar.delete(name);
		},
		getAll: () => [],
		serialize: () => ''
	};
	return { cookies: cookies as unknown as Cookies, jar };
}

test('store-then-read round-trips exactly the newest 5 states, order preserved; empty input deletes the cookie', () => {
	// Property audit: storing all states uncapped (no slice), dropping the
	// empty-array delete branch, or reordering (e.g. slice(0, 5)) flips a run
	// red: 6–8 state arrays exercise the cap, [] exercises the delete.
	fc.assert(
		fc.property(fc.array(fc.string(), { maxLength: 8 }), (states) => {
			const { cookies, jar } = cookieJar(); // fresh jar per run
			storePendingStates(cookies, states);
			if (states.length === 0) {
				expect(jar.has(OAUTH_STATE_COOKIE)).toBe(false);
			}
			expect(readPendingStates(cookies)).toEqual(states.slice(-5));
		})
	);
});

test('read is total: arbitrary raw cookie values never throw and always yield string[]', () => {
	// Property audit: returning the parsed value unfiltered (no typeof guard)
	// lets a mixed-type array run go red; an uncaught JSON.parse throw fails
	// the run directly.
	fc.assert(
		fc.property(fc.string(), (raw) => {
			const { cookies, jar } = cookieJar();
			jar.set(OAUTH_STATE_COOKIE, raw); // bypass storePendingStates: hostile raw value
			const states = readPendingStates(cookies);
			expect(Array.isArray(states)).toBe(true);
			for (const state of states) {
				expect(typeof state).toBe('string');
			}
		})
	);
});
