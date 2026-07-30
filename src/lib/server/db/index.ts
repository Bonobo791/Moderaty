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

import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { env } from '$env/dynamic/private';
import * as schema from '$lib/server/db/schema';

// The client is created lazily on first use: SvelteKit's postbuild analyse
// imports every server module, and deploy platforms build without runtime
// env vars, so validating here at module top level would fail the build.
// Validation still fails loudly — just at handler start (first DB access).
let instance: LibSQLDatabase<typeof schema> | undefined;

function createDb(): LibSQLDatabase<typeof schema> {
	const databaseUrl = env.TURSO_DATABASE_URL;
	const authToken = env.TURSO_AUTH_TOKEN;

	if (!databaseUrl) {
		throw new Error('TURSO_DATABASE_URL is required');
	}
	const isLocalUrl = databaseUrl === ':memory:' || databaseUrl.startsWith('file:');
	if (!isLocalUrl && !authToken) {
		throw new Error('TURSO_AUTH_TOKEN is required for remote databases');
	}

	const client = createClient({
		url: databaseUrl,
		authToken: authToken || undefined
	});

	return drizzle(client, { schema });
}

export const db = new Proxy({} as LibSQLDatabase<typeof schema>, {
	get(_target, property) {
		const real = (instance ??= createDb());
		const value = Reflect.get(real, property);
		return typeof value === 'function' ? value.bind(real) : value;
	}
});
