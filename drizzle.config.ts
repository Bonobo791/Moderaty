import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!databaseUrl) {
	throw new Error('TURSO_DATABASE_URL is required');
}
if (!databaseUrl.startsWith('file:') && !authToken) {
	throw new Error('TURSO_AUTH_TOKEN is required for remote databases');
}

export default defineConfig({
	// 'turso' (not 'sqlite') so drizzle-kit connects via @libsql/client, which is the
	// installed driver; the 'sqlite' dialect requires better-sqlite3 and fails silently here.
	dialect: 'turso',
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dbCredentials: {
		url: databaseUrl,
		authToken: authToken || undefined
	}
});
