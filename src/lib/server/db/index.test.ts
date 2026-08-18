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

import { expect, test, vi } from 'vitest';
import { createClient } from '@libsql/client';

// $env/dynamic/private merges values from .env files under vitest, so
// vi.stubEnv cannot unset them; mock the module instead.
const fakeEnv = vi.hoisted(() => ({ values: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: fakeEnv.values }));

// Spy on createClient to assert the exact config the db module passes to
// libsql (url + authToken handling) while keeping the real client behavior.
vi.mock('@libsql/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@libsql/client')>();
	return {
		...actual,
		createClient: vi.fn(actual.createClient)
	};
});
const createClientSpy = vi.mocked(createClient);

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

// A `file:` URL is local (no auth token required). If the local check used
// endsWith instead of startsWith, this URL would be treated as remote and
// throw TURSO_AUTH_TOKEN is required.
test('file: URL is treated as local and needs no token', async () => {
	setEnv({ TURSO_DATABASE_URL: 'file:/tmp/moderaty-mutation-kill-file-url.db' });
	vi.resetModules();
	const mod = await import('./index');
	expect(() => mod.db.select()).not.toThrow();
});

// The module must pass authToken through to createClient exactly:
// undefined when absent, the given string when present.
test('createClient receives authToken undefined for a local URL without token', async () => {
	setEnv({ TURSO_DATABASE_URL: ':memory:' });
	vi.resetModules();
	createClientSpy.mockClear();
	const mod = await import('./index');
	mod.db.select();
	expect(createClientSpy).toHaveBeenCalledWith({
		url: ':memory:',
		authToken: undefined
	});
});

test('createClient receives the provided authToken unchanged', async () => {
	setEnv({
		TURSO_DATABASE_URL: ':memory:',
		TURSO_AUTH_TOKEN: 'synthetic-test-token'
	});
	vi.resetModules();
	createClientSpy.mockClear();
	const mod = await import('./index');
	mod.db.select();
	expect(createClientSpy).toHaveBeenCalledWith({
		url: ':memory:',
		authToken: 'synthetic-test-token'
	});
});

// drizzle must be wired with the schema: without it, the relational query
// API (db.query.<table>) is missing. (db.query itself exists even without a
// schema, so assert on a real table's query entrypoint.)
test('drizzle is created with the schema (db.query table API available)', async () => {
	setEnv({ TURSO_DATABASE_URL: ':memory:' });
	vi.resetModules();
	const mod = await import('./index');
	expect(mod.db.query.users).toBeDefined();
	expect(mod.db.query.users.findMany).toBeTypeOf('function');
});

// The Proxy must bind function properties to the real drizzle instance:
// a destructured (unbound-from-proxy) method call must still work.
test('destructured db methods stay bound to the real instance', async () => {
	setEnv({ TURSO_DATABASE_URL: ':memory:' });
	vi.resetModules();
	const mod = await import('./index');
	const { select } = mod.db;
	expect(select()).toBeDefined();
});

// Non-function properties must be returned as-is, not bound (binding a
// non-function throws because .bind does not exist on it). `query` is the
// non-function property the drizzle instance exposes here.
test('non-function properties are returned without binding', async () => {
	setEnv({ TURSO_DATABASE_URL: ':memory:' });
	vi.resetModules();
	const mod = await import('./index');
	expect(mod.db.query).toBeTypeOf('object');
});
