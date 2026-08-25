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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

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
