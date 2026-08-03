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
