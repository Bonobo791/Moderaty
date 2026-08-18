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
