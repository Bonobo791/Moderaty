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
