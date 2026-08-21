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
