// Shared test fixtures with NO side effects — safe to import from test files
// that register their own module mocks (testdb.ts mocks $lib/server/db at
// module scope, which would clobber a file-local db mock).
// Never imported by app code — tests only.

/** Shared signed-in fixture: the owner of org-1 — the default tenancy context for route tests. */
export const TEST_OWNER = {
	id: 'user-1',
	email: 'one@example.com',
	displayName: 'One',
	plan: 'free',
	orgId: 'org-1',
	orgName: 'One',
	orgRole: 'owner'
} as const satisfies import('./session').SessionUser;
