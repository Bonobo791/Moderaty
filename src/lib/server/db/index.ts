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

/**
 * Retries a short transaction on SQLite lock contention. Remote Turso
 * serializes writers server-side, but file-backed libSQL (self-hosted
 * deployments, tests) can answer SQLITE_LOCKED/SQLITE_BUSY when two
 * writers race — the loser retries after the winner commits instead of
 * surfacing a raw lock error.
 */
export async function withBusyRetry<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await work();
		} catch (error) {
			const code = (error as { code?: string }).code ?? '';
			if (attempt >= attempts || !/^SQLITE_(LOCKED|BUSY)/.test(code)) throw error;
			await new Promise((resolve) => setTimeout(resolve, attempt * 25));
		}
	}
}
