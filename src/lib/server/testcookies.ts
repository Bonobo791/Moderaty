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

// Test helper: SvelteKit Cookies stand-ins. Never imported by app code —
// tests only. Kept separate from testdb.ts so route tests that mock the db
// themselves can use these without registering testdb's database mock.

/** Minimal Cookies stand-in that records set/delete calls like SvelteKit's. */
export function makeCookies() {
	const store = new Map<string, string>();
	const setCalls: Array<{ name: string; value: string; opts: Record<string, unknown> }> = [];
	const deleteCalls: Array<{ name: string; opts: Record<string, unknown> | undefined }> = [];
	return {
		setCalls,
		deleteCalls,
		get: (name: string) => store.get(name),
		set: (name: string, value: string, opts: Record<string, unknown>) => {
			setCalls.push({ name, value, opts });
			store.set(name, value);
		},
		delete: (name: string, opts?: Record<string, unknown>) => {
			deleteCalls.push({ name, opts });
			store.delete(name);
		}
	};
}

/** A cookie jar pre-seeded with pending OAuth states for callback tests. */
export function makeCookiesWithState(...states: string[]) {
	const cookies = makeCookies();
	cookies.set('oauth_state', JSON.stringify(states), { path: '/' });
	return cookies;
}
