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

import { expect, test, vi } from 'vitest';

// $env/dynamic/private merges values from .env files under vitest, so
// vi.stubEnv cannot unset them; mock the module instead.
const fakeEnv = vi.hoisted(() => ({ values: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: fakeEnv.values }));

function setEnv(values: Record<string, string | undefined>) {
	for (const key of Object.keys(fakeEnv.values)) delete fakeEnv.values[key];
	Object.assign(fakeEnv.values, values);
}

// SvelteKit's postbuild analyse imports every server module. Without env vars
// (a clean Netlify build), a top-level throw in this module fails the deploy.
// Env validation must happen at first use (handler start), not at import.
test('db module imports without env vars; first use throws loudly', async () => {
	setEnv({});
	vi.resetModules();
	const mod = await import('./index');
	expect(mod.db).toBeDefined();
	expect(() => mod.db.select()).toThrow(/TURSO_DATABASE_URL is required/);
});

test('remote URL without auth token throws loudly at first use', async () => {
	setEnv({ TURSO_DATABASE_URL: 'libsql://example.turso.io' });
	vi.resetModules();
	const mod = await import('./index');
	expect(() => mod.db.select()).toThrow(/TURSO_AUTH_TOKEN is required/);
});

test('local database URL needs no token and works at first use', async () => {
	setEnv({ TURSO_DATABASE_URL: ':memory:' });
	vi.resetModules();
	const mod = await import('./index');
	expect(() => mod.db.select()).not.toThrow();
});
