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
		if (!instance) instance = createDb();
		const value = Reflect.get(instance, property);
		return typeof value === 'function' ? value.bind(instance) : value;
	}
});
