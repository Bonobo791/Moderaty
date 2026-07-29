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

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	// 'turso' (not 'sqlite') so drizzle-kit connects via @libsql/client, which is the
	// installed driver; the 'sqlite' dialect requires better-sqlite3 and fails silently here.
	dialect: 'turso',
	schema: './src/lib/server/db/schema.ts',
	dbCredentials: {
		url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
		authToken: process.env.TURSO_AUTH_TOKEN || undefined
	}
});
