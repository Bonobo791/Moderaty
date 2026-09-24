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
